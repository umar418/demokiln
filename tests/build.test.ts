import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demo, DemoConfigError, DemoStepError, renderHtml, runDemo, SecretFoundError, type DemoOptions } from "../src/index.js";
import { safeJson } from "../src/build/html.js";
import { resolveInside } from "../src/cli/serve.js";
import { scanForSecrets } from "../src/privacy/secrets.js";
import { toHotspot } from "../src/capture/run.js";
import { startFixture } from "./helpers.js";

let base = "";
let stop: () => Promise<void>;
beforeAll(async () => ({ url: base, stop } = await startFixture()));
afterAll(() => stop());

const opts = (extra: Partial<DemoOptions> = {}): DemoOptions => ({ url: `${base}/index.html`, scale: 1, stepTimeout: 3000, ...extra });

const tour = (extra: Partial<DemoOptions> = {}) =>
  demo(opts({ title: "Northwind tour", ...extra }), async ({ page, step }) => {
    await step.click(page.getByRole("link", { name: "Reports" }), "Open your reports");
    await step.fill(page.getByLabel("From"), "2026-01-01", "Pick a start date");
    await step.click(page.getByRole("button", { name: "Apply" }), "Apply the filter");
    await step.note("Your orders appear here.", { at: "#result" });
  });

function pixel(image: Buffer, x: number, y: number): number[] {
  const png = PNG.sync.read(image);
  const i = (png.width * y + x) << 2;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
}

describe("capture", () => {
  it("captures one screen per step plus a closing screen, with hotspots inside the image", async () => {
    const result = await runDemo(tour());
    expect(result.steps.map((s) => s.kind)).toEqual(["click", "fill", "click", "note", "end"]);
    expect(result.steps.map((s) => s.caption).slice(0, 4)).toEqual([
      "Open your reports", "Pick a start date", "Apply the filter", "Your orders appear here.",
    ]);
    for (const step of result.steps.slice(0, 4)) {
      const h = step.hotspot!;
      expect(h.x).toBeGreaterThanOrEqual(0);
      expect(h.y).toBeGreaterThanOrEqual(0);
      expect(h.x + h.w).toBeLessThanOrEqual(1.00001);
      expect(h.y + h.h).toBeLessThanOrEqual(1.00001);
      expect(h.w).toBeGreaterThan(0);
    }
    expect(result.steps[4]!.hotspot).toBeUndefined();
    const png = PNG.sync.read(result.steps[0]!.image);
    expect([png.width, png.height]).toEqual([1280, 800]);
    expect(result.steps.flatMap((s) => s.warnings)).toEqual([]);
  });

  it("captures the screen before the action, so each image shows what the viewer must click", async () => {
    const result = await runDemo(tour());
    // Step 1 was taken on the home page, step 2 on the reports page: the images must differ.
    expect(result.steps[0]!.image.equals(result.steps[1]!.image)).toBe(false);
    // The closing screen shows the result of the last action, after "Apply".
    expect(result.steps[4]!.image.equals(result.steps[2]!.image)).toBe(false);
  });

  it("names the step and caption when an element is missing", async () => {
    const broken = demo(opts({ stepTimeout: 800 }), async ({ page, step }) => {
      await step.click(page.getByRole("link", { name: "Reports" }), "Open your reports");
      await step.click(page.getByRole("button", { name: "Does not exist" }), "Press the missing button");
    });
    const error = await runDemo(broken).catch((e) => e);
    expect(error).toBeInstanceOf(DemoStepError);
    expect(error.stepNumber).toBe(2);
    expect(error.message).toContain("Step 2");
    expect(error.message).toContain("Press the missing button");
  });

  it("refuses a selector that matches several elements instead of guessing", async () => {
    const vague = demo(opts({ stepTimeout: 800 }), async ({ step }) => {
      await step.click("nav a", "Click a link");
    });
    await expect(runDemo(vague)).rejects.toBeInstanceOf(DemoStepError);
  });

  it("runs hidden steps without capturing them", async () => {
    const withSetup = demo(opts(), async ({ page, step }) => {
      await step.hidden(async () => {
        await page.getByRole("link", { name: "Reports" }).click();
        await step.fill(page.getByLabel("From"), "2026-02-02", "never shown");
      });
      await step.click(page.getByRole("button", { name: "Apply" }), "Apply the filter");
    });
    const result = await runDemo(withSetup);
    expect(result.steps.map((s) => s.caption)).toEqual(["Apply the filter", "That’s the tour."]);
  });

  it("fails when a script captures nothing", async () => {
    await expect(runDemo(demo(opts(), async () => {}))).rejects.toThrow(/captured no steps/);
  });

  it("records chapters on the steps that follow", async () => {
    const chaptered = demo(opts(), async ({ page, step }) => {
      await step.note("Welcome");
      step.chapter("Reports");
      await step.click(page.getByRole("link", { name: "Reports" }), "Open your reports");
    });
    const result = await runDemo(chaptered);
    expect(result.steps.map((s) => s.chapter)).toEqual([undefined, "Reports", "Reports"]);
  });

  it("gives identical output for identical input", async () => {
    const a = renderHtml(await runDemo(tour()));
    const b = renderHtml(await runDemo(tour()));
    expect(a === b).toBe(true);
  });
});

describe("privacy", () => {
  const account = (extra: Partial<DemoOptions> = {}, query = "") =>
    demo(opts({ url: `${base}/account.html${query}`, ...extra }), async ({ page, step }) => {
      await step.click(page.getByRole("button", { name: "Save" }), "Save your settings");
    });

  it("always covers password fields", async () => {
    const result = await runDemo(account());
    const image = result.steps[0]!.image;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}/account.html`);
    const box = (await page.locator("#pw").boundingBox())!;
    await browser.close();
    // Every sampled point inside the field is the flat mask colour.
    for (const [fx, fy] of [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.5, 0.2], [0.5, 0.8]] as const) {
      expect(pixel(image, Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy))).toEqual([0xc9, 0xce, 0xd8]);
    }
  });

  it("stops the build and writes nothing when a credential is on screen", async () => {
    const error = await runDemo(account({}, "?key=1")).catch((e) => e);
    expect(error).toBeInstanceOf(SecretFoundError);
    expect(error.message).toContain("Step 1");
    expect(error.message).toContain("GitHub token");
    expect(error.message).not.toContain("A1b2");
  });

  it("lets the build continue when the credential is masked, and covers it in the image", async () => {
    const result = await runDemo(account({ mask: ["#key"] }, "?key=1"));
    expect(result.steps).toHaveLength(2);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}/account.html?key=1`);
    const box = (await page.locator("#key").boundingBox())!;
    await browser.close();
    expect(pixel(result.steps[0]!.image, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2))).toEqual([0xc9, 0xce, 0xd8]);
  });

  it("can allow a named pattern that is a known false positive", async () => {
    const result = await runDemo(account({ allowSecrets: ["github-token"] }, "?key=1"));
    expect(result.steps).toHaveLength(2);
  });

  it("replaces text before capture", async () => {
    const plain = await runDemo(demo(opts(), async ({ step }) => step.note("Home")));
    const swapped = await runDemo(
      demo(opts({ replace: { "Real Customer Ltd": "Acme Inc" } }), async ({ page, step }) => {
        await step.note("Home");
        expect(await page.locator(".customer").textContent()).toBe("Acme Inc");
      }),
    );
    expect(plain.steps[0]!.image.equals(swapped.steps[0]!.image)).toBe(false);
  });

  it("stores a typed value only as part of the screen it appears on", async () => {
    const result = await runDemo(
      demo(opts({ url: `${base}/reports.html`, capture: "screenshot" }), async ({ page, step }) => {
        await step.fill(page.getByLabel("From"), "TYPED-VALUE-123", "Pick a start date");
      }),
    );
    const html = renderHtml(result);
    const withoutImages = html.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, "");
    expect(withoutImages).not.toContain("TYPED-VALUE-123");
  });

  it("finds credentials without matching ordinary words", () => {
    expect(scanForSecrets("disk-usage sk-learn task-force")).toEqual([]);
    expect(scanForSecrets("key " + "AKIA" + "ABCDEFGHIJKLMNOP").map((h) => h.id)).toEqual(["aws-access-key-id"]);
    expect(scanForSecrets("sk-ant-" + "a".repeat(30)).map((h) => h.id)).toEqual(["anthropic-api-key"]);
  });
});

describe("options", () => {
  it("rejects unsafe or malformed settings before opening a browser", () => {
    const bad: Partial<DemoOptions>[] = [
      { url: "javascript:alert(1)" },
      { url: "ftp://example.com" },
      { cta: { label: "Go", url: "javascript:alert(1)" } },
      { cta: { label: " ", url: "https://example.com" } },
      { accent: "red" },
      { accent: "#fff;background:url(x)" },
      { viewport: { width: 10, height: 10 } },
      { viewport: "watch" as never },
      { scale: 9 },
      { replace: { "": "x" } },
      { stepTimeout: 1 },
    ];
    for (const extra of bad) {
      expect(() => demo({ url: "https://example.com", ...extra } as DemoOptions, async () => {})).toThrow(DemoConfigError);
    }
  });
});

describe("line endings", () => {
  it("builds a working demo even when the player files use Windows line endings", () => {
    // The policy hash must be computed over the text as the browser will see it.
    const html = renderHtml({
      title: "T", viewport: { width: 800, height: 600 }, time: new Date(0).toISOString(), scale: 1,
      tables: { styles: [], resources: ["data:,"] }, steps: [],
    });
    expect(html.includes("\r")).toBe(false);
  });
});

describe("output file", () => {
  async function open(html: string) {
    const file = join(mkdtempSync(join(tmpdir(), "demokiln-")), "demo.html");
    writeFileSync(file, html);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const problems: string[] = [];
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(e.message));
    const requests: string[] = [];
    page.on("request", (r) => !r.url().startsWith("data:") && !r.url().startsWith("file:") && requests.push(r.url()));
    await page.goto(pathToFileURL(file).href);
    return { browser, page, problems, requests };
  }

  it("plays through by clicking each hotspot, with no errors and no network requests", async () => {
    const html = renderHtml(await runDemo(tour({ cta: { label: "Start free", url: "https://example.com/signup" } })));
    const { browser, page, problems, requests } = await open(html);
    try {
      const caption = page.locator(".dk-cap");
      await expect.poll(() => caption.textContent()).toBe("Open your reports");
      expect(await page.locator(".dk-count").textContent()).toBe("1 / 5");
      await page.locator(".dk-hot").click();
      await expect.poll(() => caption.textContent()).toBe("Pick a start date");
      await page.locator(".dk-hot").click();
      await expect.poll(() => caption.textContent()).toBe("Apply the filter");
      await page.locator(".dk-hot").click();
      await expect.poll(() => caption.textContent()).toBe("Your orders appear here.");
      // A note's hotspot only points; the viewer moves on with Next or the keyboard.
      expect(await page.locator(".dk-hot").isDisabled()).toBe(true);
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => page.locator(".dk-end").isVisible()).toBe(true);
      expect(await page.locator(".dk-card p").textContent()).toBe("That’s the tour.");
      const link = page.locator(".dk-card a");
      expect(await link.getAttribute("href")).toBe("https://example.com/signup");
      expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
      await page.getByRole("button", { name: "Watch again" }).click();
      await expect.poll(() => caption.textContent()).toBe("Open your reports");
      await page.keyboard.press("ArrowLeft");
      expect(await page.locator(".dk-count").textContent()).toBe("1 / 5");
      expect(problems).toEqual([]);
      expect(requests).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it("keeps the hotspot over the same spot at any size", async () => {
    const result = await runDemo(tour());
    const { browser, page } = await open(renderHtml(result));
    try {
      for (const width of [1100, 900]) {
        await page.setViewportSize({ width, height: 800 });
        const stage = (await page.locator(".dk-stage").boundingBox())!;
        const hot = (await page.locator(".dk-hot").boundingBox())!;
        const expected = result.steps[0]!.hotspot!;
        // The 2px border sits inside the box, so allow a small tolerance.
        expect(Math.abs((hot.x - stage.x) / stage.width - expected.x)).toBeLessThan(0.01);
        expect(Math.abs((hot.y - stage.y) / stage.height - expected.y)).toBeLessThan(0.01);
        expect(Math.abs(stage.width / stage.height - 1280 / 800)).toBeLessThan(0.01);
        const cap = (await page.locator(".dk-cap").boundingBox())!;
        expect(cap.x).toBeGreaterThanOrEqual(stage.x);
        expect(cap.x + cap.width).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
      }
    } finally {
      await browser.close();
    }
  });

  it("moves in on the hotspot when the player is phone-sized, keeping it and the caption on screen", async () => {
    const result = await runDemo(tour());
    const { browser, page } = await open(renderHtml(result));
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 380, height: 800 });
      const expected = result.steps[0]!.hotspot!;
      const stage = (await page.locator(".dk-stage").boundingBox())!;
      await expect.poll(async () => (await page.locator(".dk-hot").boundingBox())!.width).toBeGreaterThan(expected.w * stage.width * 1.9);
      const hot = (await page.locator(".dk-hot").boundingBox())!;
      const cap = (await page.locator(".dk-cap").boundingBox())!;
      for (const box of [hot, cap]) {
        expect(box.x).toBeGreaterThanOrEqual(stage.x - 0.5);
        expect(box.y).toBeGreaterThanOrEqual(stage.y - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
        expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height + 0.5);
      }
      // The closing screen shows the whole capture again.
      await page.keyboard.press("End");
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
      await expect.poll(() => page.locator(".dk-end").isVisible()).toBe(true);
      expect(await page.evaluate('document.querySelector(".dk-layer").style.transform')).toBe("translate(0px, 0px) scale(1)");
    } finally {
      await browser.close();
    }
  });

  it("shows hostile captions and titles as plain text and runs none of it", async () => {
    const attack = '</script><img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const hostile = demo(
      opts({ title: attack, endCaption: attack, cta: { label: attack, url: "https://example.com/?q=<script>" } }),
      async ({ page, step }) => {
        await step.click(page.getByRole("link", { name: "Reports" }), attack);
      },
    );
    const { browser, page, problems } = await open(renderHtml(await runDemo(hostile)));
    try {
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe(attack);
      expect(await page.locator(".dk-title").textContent()).toBe(attack);
      await page.locator(".dk-hot").click();
      await expect.poll(() => page.locator(".dk-card p").textContent()).toBe(attack);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
      expect(await page.locator("img:not(.dk-shot)").count()).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it("blocks injected script through the page's own policy", async () => {
    const html = renderHtml(await runDemo(tour({ capture: "screenshot" })));
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'sha256-[^']+'; script-src 'sha256-[^']+'; base-uri 'none'; form-action 'none'"/);
    const tampered = html.replace("</body>", "<script>window.__injected=1</script></body>");
    const { browser, page } = await open(tampered);
    try {
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe("Open your reports");
      expect(await page.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined();
    } finally {
      await browser.close();
    }
  });

  it("escapes data so it cannot end the script element", () => {
    const separators = String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
    const value = { a: "</script><!--", b: separators + "&" };
    const json = safeJson(value);
    for (const char of ["<", ">", "&", ...separators]) expect(json.includes(char)).toBe(false);
    expect(JSON.parse(json)).toEqual(value);
  });
});

describe("helpers", () => {
  it("clips a hotspot to the visible area and drops one that is off screen", () => {
    const viewport = { width: 1000, height: 500 };
    expect(toHotspot({ x: -50, y: 450, width: 100, height: 100 }, viewport)).toEqual({ x: 0, y: 0.9, w: 0.05, h: 0.1 });
    expect(toHotspot({ x: 1200, y: 10, width: 50, height: 50 }, viewport)).toBeUndefined();
  });

  it("never serves a file outside the preview folder", () => {
    const root = resolve("srv-demo");
    expect(resolveInside(root, "/demo.html")).toBe(join(root, "demo.html"));
    for (const path of ["/../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/a/../../b", "/%00", "/%E0%A4%A", "/..%5c..%5cx", "/..\\..\\x"]) {
      const resolved = resolveInside(root, path);
      expect(resolved === undefined || resolved === root || resolved.startsWith(root + sep), path).toBe(true);
    }
    expect(resolveInside(root, "/../srv-demo-secrets/x")).toBeUndefined();
  });
});

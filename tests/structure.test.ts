import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demo, renderHtml, runDemo, type DemoOptions, type RunResult } from "../src/index.js";
import { isFaithful, measureFidelity, newTables, takeSnapshot, watchResponses } from "../src/capture/snapshot.js";
import { sanitizeCss, sanitizeHtml } from "../src/privacy/sanitize.js";
import { startFixture } from "./helpers.js";

let base = "";
let stop: () => Promise<void>;
let browser: Browser;
beforeAll(async () => {
  ({ url: base, stop } = await startFixture());
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await stop();
});

const opts = (page: string, extra: Partial<DemoOptions> = {}): DemoOptions => ({ url: `${base}/${page}`, scale: 1, stepTimeout: 3000, ...extra });

async function open(html: string, pageOptions: { colorScheme?: "light" | "dark"; width?: number } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "demokiln-")), "demo.html");
  writeFileSync(file, html);
  const page = await browser.newPage({ viewport: { width: pageOptions.width ?? 1100, height: 800 }, colorScheme: pageOptions.colorScheme ?? "light" });
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  const requests: string[] = [];
  page.on("request", (r) => !/^(data|file|about):/.test(r.url()) && requests.push(r.url()));
  await page.goto(pathToFileURL(file).href);
  await page.locator(".dk-cap, .dk-end").first().waitFor({ state: "attached" });
  return { page, problems, requests };
}

/** Runs code against the captured page shown inside the player. */
const inFrame = <T>(page: import("playwright").Page, body: string): Promise<T> =>
  page.evaluate(`(() => { const doc = document.querySelector("iframe.dk-page").contentDocument; ${body} })()`) as Promise<T>;

describe("structure capture", () => {
  it("keeps the real page for ordinary screens, embedding its images and styles", async () => {
    const result = await runDemo(
      demo(opts("media.html"), async ({ step }) => {
        await step.click("#go", "Continue");
      }),
    );
    expect(result.steps.map((s) => Boolean(s.structure))).toEqual([true, true]);
    expect(result.steps.flatMap((s) => s.notes)).toEqual([]);
    const html = renderHtml(result);
    // The logo is stored once although it is used as an image and as a background, on two screens.
    expect(html.split("data:image/svg+xml;base64,").length - 1).toBe(1);
    expect(html).not.toContain(base);
    expect(html).not.toContain("data:image/png;base64,");

    const { page, problems, requests } = await open(html);
    try {
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe("Continue");
      expect(await inFrame(page, 'return doc.querySelector("h1").textContent')).toBe("Media");
      expect(await inFrame(page, 'const i = doc.getElementById("logo"); return i.complete && i.naturalWidth')).toBe(120);
      expect(await inFrame(page, 'return doc.getElementById("agree").checked')).toBe(true);
      expect(problems).toEqual([]);
      expect(requests).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("puts the hotspot on the real element and keeps it there at any size", async () => {
    const result = await runDemo(demo(opts("media.html"), async ({ step }) => step.click("#go", "Continue")));
    const { page } = await open(renderHtml(result));
    try {
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe("Continue");
      for (const width of [1100, 900]) {
        await page.setViewportSize({ width, height: 800 });
        const stage = (await page.locator(".dk-stage").boundingBox())!;
        const frameSize = () =>
          page.evaluate('(() => { const r = document.querySelector("iframe.dk-page").getBoundingClientRect(); return [r.width, r.height]; })()') as Promise<number[]>;
        await expect.poll(async () => Math.abs((await frameSize())[0]! - stage.width)).toBeLessThan(1.5);
        expect(Math.abs((await frameSize())[1]! - stage.height)).toBeLessThan(1.5);
        const hot = (await page.locator(".dk-hot").boundingBox())!;
        const expected = result.steps[0]!.hotspot!;
        expect(Math.abs((hot.x - stage.x) / stage.width - expected.x)).toBeLessThan(0.01);
        expect(Math.abs((hot.y - stage.y) / stage.height - expected.y)).toBeLessThan(0.01);
      }
    } finally {
      await page.close();
    }
  });

  it("restores scroll positions, including inside scrolled boxes", async () => {
    const result = await runDemo(demo(opts("long.html"), async ({ step }) => step.click("#bottom", "Press the bottom button")));
    expect(result.steps[0]!.structure).toBeDefined();
    expect(result.steps[0]!.structure!.scroll[1]).toBeGreaterThan(500);
    const { page } = await open(renderHtml(result));
    try {
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe("Press the bottom button");
      expect(await page.evaluate('document.querySelector("iframe.dk-page").contentWindow.scrollY')).toBe(result.steps[0]!.structure!.scroll[1]);
      expect(await inFrame(page, 'return doc.getElementById("list").scrollTop')).toBe(240);
    } finally {
      await page.close();
    }
  });

  it("shows the captured colour scheme whatever the viewer's setting", async () => {
    const result = await runDemo(demo(opts("media.html"), async ({ step }) => step.click("#go", "Continue")));
    const { page } = await open(renderHtml(result), { colorScheme: "dark" });
    try {
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe("Continue");
      expect(await inFrame(page, "return getComputedStyle(doc.body).backgroundColor")).toBe("rgb(247, 248, 250)");
    } finally {
      await page.close();
    }
  });

  it("falls back to the screenshot, with a reason, when the copy would not match", async () => {
    const result = await runDemo(demo(opts("widget.html"), async ({ step }) => step.click("#ok", "Press OK")));
    expect(result.steps[0]!.structure).toBeUndefined();
    expect(result.steps[0]!.notes.join(" ")).toMatch(/Screenshot used: a copy of the page did not match .*shadow DOM/);
    const html = renderHtml(result);
    expect(html).toContain("data:image/png;base64,");
    const { page, problems } = await open(html);
    try {
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe("Press OK");
      expect(await page.locator("img.dk-shot").count()).toBe(1);
      expect(await page.locator("iframe").count()).toBe(0);
      expect(problems).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("uses screenshots only when asked, under the strictest policy", async () => {
    const result = await runDemo(demo(opts("media.html", { capture: "screenshot" }), async ({ step }) => step.click("#go", "Continue")));
    expect(result.steps.every((s) => !s.structure)).toBe(true);
    expect(renderHtml(result)).toMatch(/style-src 'sha256-/);
  });

  it("gives identical output for identical input", async () => {
    const build = () => runDemo(demo(opts("media.html"), async ({ step }) => step.click("#go", "Continue"))).then(renderHtml);
    expect((await build()) === (await build())).toBe(true);
  });
});

describe("fidelity gate", () => {
  async function capture(pageName: string) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const tables = newTables();
    watchResponses(context, tables);
    await page.goto(`${base}/${pageName}`);
    const screenshot = await page.screenshot({ animations: "disabled", caret: "hide" });
    const taken = await takeSnapshot({ page, context, maskSelectors: [], maskColor: "#c9ced8", scheme: "light", tables });
    return { context, page, tables, screenshot, ...taken };
  }

  it("measures no difference for a faithful copy and a clear difference for an altered one", async () => {
    const { context, tables, screenshot, snapshot } = await capture("index.html");
    try {
      const viewport = { width: 1280, height: 800 };
      const check = (candidate: typeof snapshot) => measureFidelity({ context, snapshot: candidate!, tables, screenshot, viewport });
      const faithful = await check(snapshot);
      expect(faithful).toEqual({ pixels: 0, overall: 0, worstRegion: 0 });
      expect(isFaithful(faithful, 0.002)).toBe(true);
      // One changed heading is a tiny share of the whole screen but must still be caught.
      const reworded = await check({ ...snapshot!, html: snapshot!.html.replace("Good morning", "Good evening") });
      expect(reworded.overall).toBeLessThan(0.002);
      expect(isFaithful(reworded, 0.002)).toBe(false);
      // A single changed digit in a small number.
      const digit = await check({ ...snapshot!, html: snapshot!.html.replace("<b>3</b>", "<b>8</b>") });
      expect(isFaithful(digit, 0.002)).toBe(false);
      const unstyled = await check({ ...snapshot!, html: snapshot!.html.replace(/<style>[^<]*<\/style>/g, "") });
      expect(unstyled.overall).toBeGreaterThan(0.002);
      expect(isFaithful(unstyled, 0.002)).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("never copies masked text, password values or field contents the script hid", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const tables = newTables();
    watchResponses(context, tables);
    await page.goto(`${base}/account.html?key=1`);
    const { snapshot } = await takeSnapshot({ page, context, maskSelectors: ["#key"], maskColor: "#c9ced8", scheme: "light", tables });
    await context.close();
    const everything = snapshot!.html + tables.styles.join("") + tables.resources.join("");
    expect(everything).not.toContain("A1b2");
    expect(everything).not.toContain("hunter2");
    expect(everything).toContain("Account");
  });

  it("uses a screenshot when the page source holds a credential that is not on screen", async () => {
    const result = await runDemo(
      demo(opts("index.html"), async ({ page, step }) => {
        await page.evaluate(() => document.body.setAttribute("data-token", "ghp_" + "Zz90".repeat(9)));
        await step.note("Home");
      }),
    );
    expect(result.steps[0]!.structure).toBeUndefined();
    expect(result.steps[0]!.notes[0]).toMatch(/likely credential that is not visible/);
    expect(renderHtml(result)).not.toContain("Zz90Zz90");
  });
});

describe("hostile pages", () => {
  const FORBIDDEN = /<script|<noscript|<iframe|<link|http-equiv|javascript:|\son\w+\s*=|formaction|127\.0\.0\.1:9|@import/i;

  it("removes everything that could run or load from a copied page, even when the page tampers with the copy", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const tables = newTables();
    watchResponses(context, tables);
    await page.goto(`${base}/hostile.html`);
    const { snapshot } = await takeSnapshot({ page, context, maskSelectors: [], maskColor: "#c9ced8", scheme: "light", tables });
    await context.close();
    expect(snapshot).toBeDefined();
    expect(snapshot!.html).not.toMatch(FORBIDDEN);
    expect(snapshot!.html).not.toContain("NOSCRIPT-TEXT");
    for (const css of tables.styles) expect(css).not.toMatch(FORBIDDEN);
    for (const resource of tables.resources) expect(resource.startsWith("data:")).toBe(true);

    // Put the hostile copy into a demo without the fidelity gate, to prove the player's own defences hold.
    const shot = await (await browser.newPage()).screenshot();
    const forced: RunResult = {
      title: "Hostile",
      viewport: { width: 1280, height: 800 },
      tables: { styles: tables.styles, resources: tables.resources },
      steps: [
        { kind: "note", caption: "Look", image: shot, structure: snapshot!, notes: [], warnings: [] },
        { kind: "end", caption: "Done", image: shot, structure: snapshot!, notes: [], warnings: [] },
      ],
    };
    const { page: player, requests } = await open(renderHtml(forced));
    try {
      await expect.poll(() => player.locator(".dk-cap").textContent()).toBe("Look");
      expect(await inFrame(player, 'return doc.querySelector("h1").textContent')).toBe("Hostile page");
      await player.keyboard.press("ArrowRight");
      await player.waitForTimeout(300);
      expect(await player.evaluate("window.__pwned")).toBeUndefined();
      expect(await player.evaluate('document.querySelector("iframe.dk-page").contentWindow.__pwned')).toBeUndefined();
      expect(requests).toEqual([]);
    } finally {
      await player.close();
    }
  });

  it("builds a hostile page end to end without running or loading anything", async () => {
    const result = await runDemo(demo(opts("hostile.html"), async ({ step }) => step.click("#btn", "Send")));
    const { page, requests } = await open(renderHtml(result));
    try {
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe("Send");
      await page.locator(".dk-hot").click();
      await page.waitForTimeout(200);
      expect(await page.evaluate("window.__pwned")).toBeUndefined();
      expect(requests).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("stops scripts even if a copy still contained one, because the frame cannot run code", async () => {
    const shot = await (await browser.newPage()).screenshot();
    const evil = { html: '<!doctype html><html><head></head><body><script>parent.__pwned=1</script><img src=x onerror="parent.__pwned=1"><p>hi</p></body></html>', scroll: [0, 0] as [number, number] };
    const forced: RunResult = {
      title: "Unsanitised",
      viewport: { width: 800, height: 600 },
      tables: { styles: [], resources: ["data:,"] },
      steps: [{ kind: "note", caption: "Look", image: shot, structure: evil, notes: [], warnings: [] }],
    };
    const { page } = await open(renderHtml(forced));
    try {
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe("Look");
      await page.waitForTimeout(300);
      expect(await page.evaluate("window.__pwned")).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it("cleans markup and styles given directly", () => {
    const dirty =
      '<html><head><base href="http://evil/"><link rel=stylesheet href="http://evil/a.css"><style>body{color:red}</style><style>dk-style-7f3a:3:</style></head>' +
      '<body onload="x()"><a href=" java\tscript:alert(1)" target=_blank>a</a><img src="http://evil/x.png"><img src="dk-res-7f3a:2:">' +
      '<img src="data:text/html;base64,PHNjcmlwdD4="><svg><use href="http://evil/s.svg#a"/><use href="#ok"/></svg>' +
      '<object data="x.swf"></object><embed src="x"><video src="http://evil/v.mp4"></video><div style="background:url(http://evil/b.png)">x</div><!-- note --></body></html>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toMatch(/evil|onload|javascript|<base|<link|<object|<embed|<video|data:text|color:red|note/i);
    expect(clean).toContain("<style>dk-style-7f3a:3:</style>");
    expect(clean).toContain('src="dk-res-7f3a:2:"');
    expect(clean).toContain('href="#ok"');
    expect(clean).toContain("<a>a</a>");
    expect(sanitizeHtml('<a href="https://example.com/x" target="_blank" download>go</a>')).toContain('<a href="#">go</a>');

    const css = sanitizeCss('@import "http://evil/a.css"; a{background:url(http://evil/x.png)} b{background:url("dk-res-7f3a:1:")} c{width:expression(alert(1))} </style><script>x</script>');
    expect(css).not.toMatch(/evil|@import|expression\(|<\/style/i);
    expect(css).toContain('url("dk-res-7f3a:1:")');

    // Text that only becomes dangerous once a removal has joined its two halves.
    for (const tricky of ['@im@import "x";port url(http://evil/a.css);', "a{}<!<!---- b{}", "a{}--!--!>> b{}", "@@import x;import url(http://evil/b.css);", "<!-<!---<!---- x"]) {
      const cleaned = sanitizeCss(tricky);
      expect(cleaned, tricky).not.toMatch(/@import|<!--|-->|--!>|evil/i);
    }
  });
});

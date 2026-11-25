import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  annotate, attachRecorder, compareWithBaseline, DemoStepError, embedSnippet, escapeMarkdown, exportDemo, parseYamlDemo,
  readBaseline, renderCheckReport, renderHtml, runDemo, tidy, toStepsFile, writeBaseline, type RecordedStep, type RunResult,
} from "../src/index.js";
import { main } from "../src/cli/index.js";
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

const temp = () => mkdtempSync(join(tmpdir(), "demokiln-"));
const orders = (query = "", caption = "Send the orders") =>
  parseYamlDemo(`url: ${base}/versioned.html${query}\nscale: 1\nstepTimeout: 1500\ntitle: Orders\nsteps:\n  - click: Send\n    caption: ${caption}\n`);

describe("check", () => {
  it("reports nothing when the app has not changed", async () => {
    const dir = join(temp(), "demo.baseline");
    writeBaseline(dir, await runDemo(orders()));
    expect(compareWithBaseline(readBaseline(dir), await runDemo(orders()))).toEqual([]);
  });

  it("reports a screen that looks different, with both images", async () => {
    const dir = join(temp(), "demo.baseline");
    writeBaseline(dir, await runDemo(orders()));
    const changes = compareWithBaseline(readBaseline(dir), await runDemo(orders("?v=3")));
    expect(changes.map((c) => [c.number, c.kind])).toEqual([[1, "looks different"], [2, "looks different"]]);
    expect(changes[0]!.before && changes[0]!.after).toBeTruthy();
    expect(changes[0]!.share).toBeGreaterThan(0);
  });

  it("fails on a step that no longer works, before comparing anything", async () => {
    const error = await runDemo(orders("?v=2")).catch((e) => e);
    expect(error).toBeInstanceOf(DemoStepError);
    expect(error.message).toMatch(/Step 1 .*nothing visible on the page matches “Send”/);
  });

  it("reports changed captions and added or removed screens", async () => {
    const dir = join(temp(), "demo.baseline");
    const first = await runDemo(orders());
    writeBaseline(dir, first);
    const reworded = compareWithBaseline(readBaseline(dir), await runDemo(orders("", "Ship them")));
    expect(reworded.map((c) => c.kind)).toEqual(["caption changed"]);
    const shorter: RunResult = { ...first, steps: first.steps.slice(0, 1) };
    expect(compareWithBaseline(readBaseline(dir), shorter).map((c) => c.kind)).toEqual(["screen removed"]);
    writeBaseline(dir, shorter);
    expect(compareWithBaseline(readBaseline(dir), first).map((c) => c.kind)).toEqual(["new screen"]);
  });

  it("only touches its own files in the baseline folder and refuses a manifest that points elsewhere", async () => {
    const dir = join(temp(), "demo.baseline");
    const result = await runDemo(orders());
    writeBaseline(dir, result);
    writeFileSync(join(dir, "notes.txt"), "keep me");
    writeBaseline(dir, { ...result, steps: result.steps.slice(0, 1) });
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("keep me");
    expect(existsSync(join(dir, "step-002.png"))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8"));
    manifest.steps[0].file = "../../../etc/hosts";
    writeFileSync(join(dir, "baseline.json"), JSON.stringify(manifest));
    expect(() => readBaseline(dir)).toThrow(/unexpected file/);
    expect(() => readBaseline(join(dir, "missing"))).toThrow(/No baseline/);
  });

  it("writes a report that shows hostile text as text and contains no script", async () => {
    const attack = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=1">';
    const shot = (await runDemo(orders())).steps[0]!.image;
    const html = renderCheckReport(attack, [{ number: 1, caption: attack, kind: "looks different", share: 0.1, before: shot, after: shot }]);
    expect(html).toContain("default-src 'none'");
    const file = join(temp(), "report.html");
    writeFileSync(file, html);
    const page = await browser.newPage();
    try {
      await page.goto(pathToFileURL(file).href);
      expect(await page.locator("section p").textContent()).toBe(attack);
      expect(await page.evaluate("window.__pwned")).toBeUndefined();
      expect(await page.locator("script").count()).toBe(0);
      expect(await page.locator("img").count()).toBe(2);
    } finally {
      await page.close();
    }
  });

  it("works from the command line: 0 when current, 2 when out of date, 1 when a step breaks", async () => {
    const dir = temp();
    // One script file whose target address is rewritten, as if the app behind it had changed.
    const script = (query: string) => {
      const file = join(dir, "demo.yaml");
      writeFileSync(file, `url: ${base}/versioned.html${query}\nscale: 1\nstepTimeout: 1500\ntitle: Orders\nsteps:\n  - click: Send\n    caption: Send the orders\n`);
      return file;
    };
    const lines: string[] = [];
    const out = (line: string) => lines.push(line);
    const demoFile = join(dir, "out", "demo.html");
    expect(await main(["build", script(""), "-o", demoFile], out)).toBe(0);
    expect(existsSync(demoFile)).toBe(true);
    expect(lines.join("\n")).toMatch(/<iframe src="demo\.html" title="Orders"/);
    expect(lines.join("\n")).toContain("All 2 screens kept as real pages");
    const baseline = join(dir, "out", "demo.baseline");
    expect(existsSync(join(baseline, "baseline.json"))).toBe(true);

    expect(await main(["check", script(""), "--baseline", baseline], out)).toBe(0);
    const report = join(dir, "out", "changes.html");
    expect(await main(["check", script("?v=3"), "--baseline", baseline, "--report", report], out)).toBe(2);
    expect(readFileSync(report, "utf8")).toContain("the last build");
    expect(lines.join("\n")).toContain(`Rebuild with: demokiln build ${script("?v=3")}`);
    expect(await main(["check", script("?v=3"), "--no-visual"], out)).toBe(0);
    await expect(main(["check", script("?v=2"), "--baseline", baseline], out)).rejects.toBeInstanceOf(DemoStepError);

    const quiet = join(dir, "quiet", "demo.html");
    expect(await main(["build", script(""), "-o", quiet, "--no-baseline"], out)).toBe(0);
    expect(existsSync(join(dir, "quiet", "demo.baseline"))).toBe(false);
  });
});

describe("export", () => {
  it("writes a guide, an annotated image per screen and a description", async () => {
    const result = await runDemo(
      parseYamlDemo(`url: ${base}/index.html\nscale: 1\ntitle: Tour\naccent: "#ff0000"\nsteps:\n  - note: Welcome\n  - chapter: Reports\n  - click: Reports\n    caption: Open your reports\n`),
    );
    const dir = join(temp(), "export");
    const { files } = exportDemo(result, dir);
    expect(files.sort()).toEqual(["demo.json", "guide.md", "images/step-01.png", "images/step-02.png", "images/step-03.png"].sort());
    expect(readFileSync(join(dir, "guide.md"), "utf8")).toBe(
      "# Tour\n\n1. Welcome\n\n   ![Step 1](images/step-01.png)\n\n## Reports\n\n2. Open your reports\n\n   ![Step 2](images/step-02.png)\n\nThat’s the tour\\.\n\n![Result](images/step-03.png)\n",
    );
    const description = JSON.parse(readFileSync(join(dir, "demo.json"), "utf8"));
    expect(description.steps.map((s: { kind: string }) => s.kind)).toEqual(["note", "click", "end"]);
    expect(description.steps[1].hotspot.w).toBeGreaterThan(0);

    // The outline is drawn just outside the element, in the accent colour.
    const step = result.steps[1]!;
    const marked = PNG.sync.read(annotate(step, "#ff0000"));
    const x = Math.round((step.hotspot!.x + step.hotspot!.w / 2) * marked.width);
    const y = Math.max(0, Math.round(step.hotspot!.y * marked.height) - 5);
    const i = (marked.width * y + x) << 2;
    expect([marked.data[i], marked.data[i + 1], marked.data[i + 2]]).toEqual([255, 0, 0]);
    expect(annotate(result.steps[0]!).equals(result.steps[0]!.image)).toBe(true);
  });

  it("keeps captions from becoming links, images, headings or markup in the guide", () => {
    const escaped = escapeMarkdown("# [x](javascript:alert(1)) ![i](http://e/x.png) <script>a</script>\n## two `c` *b*");
    expect(escaped).not.toMatch(/(^|[^\\])[[\]()#`*<>!]/);
    expect(escaped).not.toContain("\n");
  });

  it("escapes the embed snippet", async () => {
    const result = await runDemo(orders());
    const snippet = embedSnippet('a"b<c>.html', { ...result, title: '"><script>x</script>' });
    expect(snippet).not.toMatch(/<script|"b<c>/);
    expect(snippet).toContain("aspect-ratio:1280 / 932");
  });
});

describe("recorder", () => {
  it("turns clicks and typing into a steps file that builds", async () => {
    const context = await browser.newContext();
    const steps: RecordedStep[] = [];
    await attachRecorder(context, (step) => steps.push(step));
    const page = await context.newPage();
    await page.goto(`${base}/index.html`);
    await page.getByRole("link", { name: "Reports" }).click();
    await page.getByLabel("From").click();
    await page.getByLabel("From").pressSequentially("2026");
    await page.getByLabel("From").blur();
    await page.getByLabel("From").fill("2026-04-04");
    await page.getByLabel("From").blur();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => steps.length).toBeGreaterThanOrEqual(4);
    await context.close();

    expect(tidy(steps)).toEqual([
      { kind: "click", target: "Reports" },
      { kind: "fill", target: "From", value: "2026-04-04" },
      { kind: "click", target: "Apply" },
    ]);
    const source = toStepsFile(`${base}/index.html`, steps);
    const result = await runDemo(parseYamlDemo(source.replace("title:", "scale: 1\ntitle:")));
    expect(result.steps.map((s) => s.caption)).toEqual(["Click “Reports”", "Fill in “From”", "Click “Apply”", "That’s the tour."]);
  });

  it("never writes a typed password, and ignores anything malformed a page sends", async () => {
    const context = await browser.newContext();
    const steps: RecordedStep[] = [];
    await attachRecorder(context, (step) => steps.push(step));
    const page = await context.newPage();
    await page.goto(`${base}/account.html`);
    await page.locator("#pw").fill("my-real-password");
    await page.locator("#pw").blur();
    await page.evaluate(() => {
      const send = (window as unknown as { __demokilnRecord: (s: string) => void }).__demokilnRecord;
      send("not json");
      send(JSON.stringify({ kind: "run", target: "rm -rf" }));
      send(JSON.stringify({ kind: "click", target: "x".repeat(5000) }));
      send(JSON.stringify({ kind: "fill", target: "a" }));
      send(JSON.stringify({ kind: "click", target: "Save" }));
    });
    await expect.poll(() => steps.length).toBe(2);
    await context.close();
    expect(steps).toEqual([
      { kind: "fill", target: "Password", value: "${DEMO_PASSWORD}" },
      { kind: "click", target: "Save" },
    ]);
    expect(toStepsFile("http://x.test", steps)).not.toContain("my-real-password");
  });
});

describe("autoplay", () => {
  it("advances by itself and stops as soon as the viewer does anything", async () => {
    const result = await runDemo(
      parseYamlDemo(`url: ${base}/index.html\nscale: 1\nautoplay: 800\nsteps:\n  - note: One\n  - note: Two\n  - note: Three\n`),
    );
    const file = join(temp(), "demo.html");
    writeFileSync(file, renderHtml(result));
    const page = await browser.newPage();
    try {
      await page.goto(pathToFileURL(file).href);
      await expect.poll(() => page.locator(".dk-cap").textContent()).toBe("One");
      await expect.poll(() => page.locator(".dk-cap").textContent(), { timeout: 4000 }).toBe("Two");
      await page.keyboard.press("Shift");
      await page.waitForTimeout(1800);
      expect(await page.locator(".dk-cap").textContent()).toBe("Two");
    } finally {
      await page.close();
    }
  });
});

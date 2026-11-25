import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  attachRecorder, compareWithBaseline, demo, DemoConfigError, DemoStepError, parseYamlDemo, readBaseline, renderHtml, runDemo,
  tidy, toStepsFile, writeBaseline, type DemoOptions, type RecordedStep, type RunResult,
} from "../src/index.js";
import { main } from "../src/cli/index.js";
import { serveStatic } from "../src/cli/serve.js";
import { servePage, startFixture, temp } from "./helpers.js";

// Regression tests for defects found by independent correctness testing.
// Each "it" names the promise that was broken.

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

const HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{font:16px system-ui,sans-serif;margin:24px}button{font:inherit}</style>';

/** Builds a demo of one page of HTML. */
async function build(html: string, run: Parameters<typeof demo>[1], extra: Partial<DemoOptions> = {}): Promise<RunResult> {
  const page = await servePage(html);
  try {
    return await runDemo(demo({ url: page.url, scale: 1, stepTimeout: 3000, ...extra }, run));
  } finally {
    await page.stop();
  }
}

async function openDemo(result: RunResult, options: BrowserContextOptions = {}, from: Browser = browser): Promise<Page> {
  const file = join(temp(), "demo.html");
  writeFileSync(file, renderHtml(result));
  const context = await from.newContext({ viewport: { width: 1320, height: 960 }, ...options });
  const page = await context.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.locator(".dk-cap, .dk-end").first().waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelector(".dk-view:not(.dk-loading)"));
  return page;
}

const inFrame = <T>(page: Page, body: string): Promise<T> =>
  page.evaluate(`(() => { const doc = document.querySelector("iframe.dk-page").contentDocument; ${body} })()`) as Promise<T>;

const copyOf = (result: RunResult, index: number) => result.steps[index]!.structure?.html ?? "";

describe("a screen is captured only once the app has finished", () => {
  const loading = (script: string) =>
    `${HEAD}</head><body><button id="go">Load</button><p id="out" style="color:#b00">Idle</p><script>
      document.getElementById("go").addEventListener("click", function () {
        var out = document.getElementById("out"); out.textContent = "Loading…";
        var done = function () { out.textContent = "LOADED-RESULT"; out.style.color = "#070"; };
        ${script}
      });</script></body></html>`;

  it.each([
    ["a 200 ms timer", "setTimeout(done, 200);"],
    ["a 1.2 s timer", "setTimeout(done, 1200);"],
    ["a 3 s timer", "setTimeout(done, 3000);"],
    ["a chain of timers", "setTimeout(function () { setTimeout(function () { setTimeout(done, 300); }, 300); }, 300);"],
    ["45 animation frames", "var n = 0; (function tick() { if (++n < 45) requestAnimationFrame(tick); else done(); })();"],
  ])("waits for %s before capturing the next screen", async (_name, script) => {
    const result = await build(loading(script), async ({ step }) => step.click("#go", "Load the data"));
    expect(result.steps[1]!.warnings).toEqual([]);
    expect(copyOf(result, 1)).toContain("LOADED-RESULT");
    expect(copyOf(result, 0)).toContain("Idle");
  });

  it("waits for a slow request before capturing the next screen", async () => {
    const slow = createServer((request, response) => {
      response.setHeader("access-control-allow-origin", "*");
      if (request.url === "/data") setTimeout(() => response.end("LOADED-RESULT"), 1100);
      else {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(
          `${HEAD}</head><body><button id="go">Load</button><p id="out">Idle</p><script>document.getElementById("go").addEventListener("click", function () {
            document.getElementById("out").textContent = "Loading…";
            fetch("/data").then(function (r) { return r.text(); }).then(function (t) { document.getElementById("out").textContent = t; });
          });</script></body></html>`,
        );
      }
    });
    await new Promise<void>((done) => slow.listen(0, "127.0.0.1", () => done()));
    const url = `http://127.0.0.1:${(slow.address() as { port: number }).port}/`;
    try {
      const result = await runDemo(demo({ url, scale: 1 }, async ({ step }) => step.click("#go", "Load the data")));
      expect(copyOf(result, 1)).toContain("LOADED-RESULT");
    } finally {
      await new Promise<void>((done) => (slow as Server).close(() => done()));
    }
  });

  it("does not wait forever, or warn, for a page that polls in the background", async () => {
    const started = Date.now();
    const result = await build(
      `${HEAD}</head><body><button id="go">Go</button><script>(function poll() { window.__n = (window.__n || 0) + 1; setTimeout(poll, 300); })();</script></body></html>`,
      async ({ step }) => step.click("#go", "Go"),
    );
    expect(result.steps.flatMap((s) => s.warnings)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(12_000);
  });

  it("warns when the app never finishes", async () => {
    const result = await build(
      `${HEAD}</head><body><button id="go">Go</button><p id="t">0</p><script>setInterval(function () { document.getElementById("t").textContent = String(performance.now()); }, 40);</script></body></html>`,
      async ({ step }) => step.click("#go", "Go"),
      { settleTimeout: 1500 },
    );
    expect(result.steps[0]!.warnings.join(" ")).toMatch(/still changing/);
  });
});

describe("a hotspot never points at something that covers the target", () => {
  it("scrolls a target out from under a fixed bar", async () => {
    const result = await build(
      `${HEAD}<style>#bar{position:fixed;left:0;right:0;bottom:0;height:140px;background:#222;color:#fff}</style></head><body>
       <div style="height:560px"></div><button id="pay">Pay now</button><div style="height:1200px"></div><div id="bar">We use cookies</div></body></html>`,
      async ({ step }) => step.click("#pay", "Pay"),
      { viewport: { width: 1000, height: 700 } },
    );
    const spot = result.steps[0]!.hotspot!;
    // The bar occupies the bottom 140 of 700 pixels: the hotspot must be above it.
    expect((spot.y + spot.h) * 700).toBeLessThanOrEqual(560);
  });

  it("fails, naming what is in the way, when the target cannot be uncovered", async () => {
    const error = await build(
      `${HEAD}<style>#veil{position:fixed;inset:0;background:rgba(0,0,0,.6)}</style></head><body><button id="pay">Pay now</button><div id="veil">Accept cookies to continue</div></body></html>`,
      async ({ page, step }) => {
        // Playwright itself would refuse to click through the veil; a note has no click to save it.
        await step.note("This is the pay button", { at: page.locator("#pay") });
      },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(DemoStepError);
    expect(error.message).toMatch(/covered by <div#veil> “Accept cookies/);
  });
});

describe("check tells the truth", () => {
  const invoice = (variant: string) => `${HEAD}<style>
      #total{font-size:12px} #go{background:${variant === "colour" ? "#5f56f5" : "#4f46e5"};color:#fff;border:0;padding:8px 14px}
      #row{background:${variant === "row" ? "#eee" : "#fff"};padding:6px} #dot{width:8px;height:8px;background:red;position:absolute;right:40px;top:40px}
    </style></head><body><h1>Invoice</h1><div id="row">Total <span id="total">${variant === "digit" ? "$1,800.00" : variant === "comma" ? "$1.300.00" : "$1,300.00"}</span></div>
    ${variant === "dot" ? '<div id="dot"></div>' : ""}<p><button id="go">Send invoice</button> <button id="del">Delete account</button></p></body></html>`;
  const tour = async ({ step }: Parameters<Parameters<typeof demo>[1]>[0]) => step.note("Review the invoice", { at: "#go" });

  it.each(["digit", "comma", "colour", "row", "dot"])("notices a small change (%s) at scale 1 and scale 2", async (variant) => {
    for (const scale of [1, 2]) {
      const dir = join(temp(), "demo.baseline");
      writeBaseline(dir, await build(invoice("none"), tour, { scale }));
      expect(compareWithBaseline(readBaseline(dir), await build(invoice("none"), tour, { scale }))).toEqual([]);
      const changes = compareWithBaseline(readBaseline(dir), await build(invoice(variant), tour, { scale }));
      expect(changes.map((c) => c.kind), `${variant} at scale ${scale}`).toContain("looks different");
    }
  });

  it("notices when a hotspot points at a different element, and when settings change", async () => {
    const dir = join(temp(), "demo.baseline");
    writeBaseline(dir, await build(invoice("none"), tour, { title: "Invoices" }));
    const moved = await build(invoice("none"), async ({ step }) => step.note("Review the invoice", { at: "#del" }), { title: "Invoices" });
    expect(compareWithBaseline(readBaseline(dir), moved).map((c) => c.kind)).toEqual(["points somewhere else"]);
    const retitled = await build(invoice("none"), tour, { title: "Billing", autoplay: 2000, cta: { label: "Go", url: "https://example.com" } });
    expect(compareWithBaseline(readBaseline(dir), retitled).map((c) => c.caption)).toEqual(["The title changed", "Autoplay changed", "The closing button changed"]);
    const chaptered = await build(invoice("none"), async ({ step }) => (step.chapter("Billing"), step.note("Review the invoice", { at: "#go" })), { title: "Invoices" });
    expect(compareWithBaseline(readBaseline(dir), chaptered).map((c) => c.kind)).toEqual(["chapter changed", "chapter changed"]);
  });

  it("refuses to compare against a baseline built at another size, or a damaged one", async () => {
    const dir = join(temp(), "demo.baseline");
    const result = await build(invoice("none"), tour);
    writeBaseline(dir, result);
    expect(() => compareWithBaseline(readBaseline(dir), { ...result, scale: 2 })).toThrow(/built at 1280×800 \(scale 1\)/);
    expect(() => compareWithBaseline(readBaseline(dir), { ...result, viewport: { width: 834, height: 1112 } })).toThrow(/Rebuild the demo/);
    writeFileSync(join(dir, "step-001.png"), "not a png at all");
    expect(() => compareWithBaseline(readBaseline(dir), result)).toThrow(/step-001\.png is not a readable image/);
  });

  it("does not call an unchanged app out of date because it shows the date, the time to the minute, or a random number", async () => {
    const clock = `${HEAD}</head><body><h1>Dashboard</h1><p id="now"></p><p id="id"></p><button id="go">Refresh</button>
      <script>document.getElementById("now").textContent = new Date().toISOString().slice(0, 16); document.getElementById("id").textContent = "ref-" + Math.random();</script></body></html>`;
    const page = await servePage(clock);
    const dir = temp();
    const script = join(dir, "demo.yaml");
    writeFileSync(script, `url: ${page.url}\nscale: 1\nsteps:\n  - click: Refresh\n    caption: Refresh\n`);
    const output = join(dir, "demo.html");
    const lines: string[] = [];
    try {
      expect(await main(["build", script, "-o", output], (line) => lines.push(line))).toBe(0);
      await new Promise((r) => setTimeout(r, 1100));
      expect(await main(["check", script, "--baseline", join(dir, "demo.baseline")], (line) => lines.push(line))).toBe(0);
      // With the time written in the script, two builds are the same file.
      const fixed = () => runDemo(demo({ url: page.url, scale: 1, time: "2026-03-04T05:06:07Z" }, async ({ step }) => step.click("#go", "Refresh"))).then(renderHtml);
      const first = await fixed();
      expect(first).toContain("2026-03-04T05:06");
      expect((await fixed()) === first).toBe(true);
    } finally {
      await page.stop();
    }
  });

  it("says so when a screen changes by itself, instead of only calling the demo out of date", async () => {
    let served = 0;
    const counter = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`${HEAD}</head><body><h1>Queue</h1><p>Ticket number ${++served * 7919}</p><button>Next</button></body></html>`);
    });
    await new Promise<void>((done) => counter.listen(0, "127.0.0.1", () => done()));
    const dir = temp();
    const script = join(dir, "demo.yaml");
    writeFileSync(script, `url: http://127.0.0.1:${(counter.address() as { port: number }).port}/\nscale: 1\nsteps:\n  - note: The queue\n`);
    const lines: string[] = [];
    try {
      expect(await main(["build", script, "-o", join(dir, "demo.html")], () => {})).toBe(0);
      expect(await main(["check", script, "--baseline", join(dir, "demo.baseline"), "--report", join(dir, "r.html")], (line) => lines.push(line))).toBe(2);
      expect(lines.join("\n")).toMatch(/part of it changes by itself/);
    } finally {
      await new Promise<void>((done) => (counter as Server).close(() => done()));
    }
  });

  it("refuses a baseline that belongs to another script", async () => {
    const dir = temp();
    const one = join(dir, "one.yaml");
    const two = join(dir, "two.yaml");
    for (const file of [one, two]) writeFileSync(file, `url: ${base}/index.html\nscale: 1\nsteps:\n  - note: Home\n`);
    const here = process.cwd();
    process.chdir(dir);
    try {
      expect(await main(["build", one], () => {})).toBe(0);
      // The default folder was written for one.yaml, so checking two.yaml against it is refused.
      await expect(main(["check", two], () => {})).rejects.toThrow(/belongs to one\.yaml, not two\.yaml/);
      // A folder the person names is used as given.
      expect(await main(["check", two, "--baseline", join(dir, "demo.baseline")], () => {})).toBe(0);
    } finally {
      process.chdir(here);
    }
  });
});

describe("a kept copy looks the same for every viewer", () => {
  const page = `${HEAD}<style>
      .box{width:200px;height:40px;margin:8px 0;background:rgb(200,0,0)}
      @media (min-resolution: 2dppx){#density{background:rgb(0,128,0)}}
      @media (hover: hover) and (pointer: fine){#pointer{background:rgb(0,128,0)}}
      @media (prefers-contrast: no-preference){#contrast{background:rgb(0,128,0)}}
      @media (forced-colors: none){#forced{background:rgb(0,128,0)}}
      @media (prefers-color-scheme: light){#scheme{background:rgb(0,128,0)}}
      @supports (display:grid){@media (min-resolution: 2dppx){#nested{background:rgb(0,128,0)}}}
      #card{color-scheme:light dark;background:Canvas;color:CanvasText;border:1px solid}
      #pick{background-image:image-set(linear-gradient(rgb(200,0,0),rgb(200,0,0)) 1x, linear-gradient(rgb(0,128,0),rgb(0,128,0)) 2x)}
    </style></head><body>
    <div class="box" id="density"></div><div class="box" id="pointer"></div><div class="box" id="contrast"></div><div class="box" id="forced"></div>
    <div class="box" id="scheme"></div><div class="box" id="nested"></div><div class="box" id="card">Card</div><div class="box" id="pick"></div>
    <button id="go">Go</button></body></html>`;
  const green = "rgb(0, 128, 0)";

  it("when their screen density, pointer, contrast, colours or colour scheme differ from the capture", async () => {
    const result = await build(page, async ({ step }) => step.click("#go", "Go"), { scale: 2 });
    expect(result.steps[0]!.structure).toBeDefined();
    const viewers: BrowserContextOptions[] = [
      { deviceScaleFactor: 1 },
      { deviceScaleFactor: 3, hasTouch: true, isMobile: true },
      { colorScheme: "dark", contrast: "more" },
      { forcedColors: "active", colorScheme: "dark" },
    ];
    for (const viewer of viewers) {
      const player = await openDemo(result, viewer);
      try {
        for (const id of ["density", "pointer", "contrast", "forced", "scheme", "nested"]) {
          expect(await inFrame(player, `return getComputedStyle(doc.getElementById("${id}")).backgroundColor`), `${id} for ${JSON.stringify(viewer)}`).toBe(green);
        }
        // System colour names follow a forced-colours palette whatever the page asks; that case is a documented limit.
        if (!viewer.forcedColors) {
          expect(await inFrame(player, 'return getComputedStyle(doc.getElementById("card")).backgroundColor'), `card for ${JSON.stringify(viewer)}`).toBe("rgb(255, 255, 255)");
        }
        expect(await inFrame(player, 'return getComputedStyle(doc.getElementById("pick")).backgroundImage')).toContain("rgb(0, 128, 0)");
        expect(await inFrame(player, 'return getComputedStyle(doc.getElementById("pick")).backgroundImage')).not.toContain("image-set");
      } finally {
        await player.context().close();
      }
    }
  });

  it("when their system always shows scrollbars", async () => {
    const result = await runDemo(demo({ url: `${base}/long.html`, scale: 1 }, async ({ step }) => step.click("#bottom", "Press the bottom button")));
    expect(result.steps[0]!.structure).toBeDefined();
    const classic = await chromium.launch({ args: ["--disable-features=OverlayScrollbar"] });
    try {
      const player = await openDemo(result, {}, classic);
      expect(await inFrame(player, "return doc.documentElement.clientWidth")).toBe(1280);
      expect(await inFrame(player, 'const list = doc.getElementById("list"); return list.offsetWidth - list.clientWidth')).toBeLessThanOrEqual(2);
    } finally {
      await classic.close();
    }
  });
});

describe("the copy is checked strictly against the real screen", () => {
  it("falls back when a small visible thing is missing from the copy", async () => {
    const result = await build(
      `${HEAD}</head><body><h1>Status</h1><x-dot></x-dot><button id="go">Go</button>
       <script>customElements.define("x-dot", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = '<i style="display:block;width:8px;height:8px;background:red"></i>'; } });</script></body></html>`,
      async ({ step }) => step.click("#go", "Go"),
    );
    expect(result.steps[0]!.structure).toBeUndefined();
    expect(result.steps[0]!.notes[0]).toMatch(/did not match the real screen exactly/);
  });

  it("keeps ordinary screens after clicking a plain button many times", async () => {
    const result = await build(
      `${HEAD}<style>tr:hover{background:#eef2f7} a:hover{color:red} .tab:hover{background:#ddd}</style></head><body>
       <table><tr><td>Row one</td><td><button id="plain">Count</button></td></tr></table><a href="#" id="link">A link</a> <span id="n">0</span>
       <script>document.getElementById("plain").addEventListener("click", function () { var n = document.getElementById("n"); n.textContent = String(Number(n.textContent) + 1); });</script></body></html>`,
      async ({ step }) => {
        for (let i = 0; i < 4; i++) await step.click("#plain", `Click ${i + 1}`);
        await step.click("#link", "Follow the link");
      },
    );
    expect(result.steps.map((s) => Boolean(s.structure))).toEqual([true, true, true, true, true, true]);
  });

  it("keeps a page whose body is the scrolling area", async () => {
    const result = await build(
      `${HEAD}<style>html,body{height:100%;margin:0}body{overflow:auto}</style></head><body><div style="height:1500px;background:linear-gradient(#fff,#9cf)"></div><button id="deep">Deep</button><div style="height:400px"></div></body></html>`,
      async ({ step }) => step.click("#deep", "Deep"),
    );
    expect(result.steps[0]!.notes).toEqual([]);
    expect(result.steps[0]!.structure).toBeDefined();
  });
});

describe("text never silently picks one of several matches", () => {
  it("refuses a button and a link with the same name", async () => {
    const error = await build(`${HEAD}</head><body><button>Reports</button> <a href="#">Reports</a></body></html>`, async ({ step }) => step.click({ text: "Reports" }, "Open reports")).catch((e) => e);
    expect(error).toBeInstanceOf(DemoStepError);
    expect(error.message).toMatch(/2 elements match “Reports” \(a button, a link\)/);
  });

  it("refuses a labelled field and another field with the same placeholder", async () => {
    const error = await build(
      `${HEAD}</head><body><label for="a">Name</label><input id="a"><input placeholder="Name"></body></html>`,
      async ({ step }) => step.fill({ text: "Name" }, "x", "Type a name"),
    ).catch((e) => e);
    expect(error.message).toMatch(/2 elements match “Name”/);
  });

  it("ignores hidden copies, and treats a label and its field as one thing", async () => {
    const result = await build(
      `${HEAD}</head><body><p>Billing</p><p style="display:none">Billing</p><label for="e">Email</label><input id="e"><button>Save</button><button hidden>Save</button></body></html>`,
      async ({ step }) => {
        await step.note("The billing area", { at: { text: "Billing" } });
        await step.fill({ text: "Email" }, "a@example.com", "Type your email");
        await step.click({ text: "Email" }, "Click the email field");
        await step.click({ text: "Save" }, "Save");
      },
    );
    expect(result.steps).toHaveLength(5);
  });
});

describe("errors say where the demo had got to", () => {
  it("names a failing hidden step and a failure in the script's own code", async () => {
    const hidden = await runDemo(
      parseYamlDemo(`url: ${base}/index.html\nscale: 1\nstepTimeout: 800\nsteps:\n  - note: Home\n  - hidden:\n      - click: No Such Thing\n  - note: Never\n`),
    ).catch((e) => e);
    expect(hidden.message).toMatch(/^A hidden click step before screen 2 failed: nothing visible on the page matches “No Such Thing”/);

    const own = await runDemo(
      demo({ url: `${base}/index.html`, scale: 1, stepTimeout: 800 }, async ({ page, step }) => {
        await step.note("Home");
        await page.click("#nothing-here", { timeout: 300 });
      }),
    ).catch((e) => e);
    expect(own).toBeInstanceOf(DemoStepError);
    expect(own.message).toMatch(/^The script failed after screen 1 \(“Home”\): /);
  });
});

describe("settings and steps files are checked, never half-accepted", () => {
  it("rejects wrong kinds of value", () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ mask: "nav" }, /mask must be a list/],
      [{ allowSecrets: "jwt" }, /allowSecrets must be a list/],
      [{ allowSecrets: ["made-up"] }, /unknown id "made-up"/],
      [{ autoplay: "1000" }, /autoplay must be a number/],
      [{ title: 123 }, /title must be text/],
      [{ endCaption: 5 }, /endCaption must be text/],
      [{ colorScheme: "Dark" }, /colorScheme must be/],
      [{ storageState: 5 }, /storageState must be text/],
      [{ viewport: { width: 800, height: 600, depth: 2 } }, /viewport has an unknown setting "depth"/],
      [{ cta: { label: "Go", url: "https://example.com", colour: "red" } }, /cta has an unknown setting "colour"/],
      [{ time: "next tuesday" }, /time must be a date/],
      [{ colour: "red" }, /Unknown setting "colour"/],
      [{ replace: ["a", "b"] }, /replace must be pairs/],
    ];
    for (const [extra, message] of bad) {
      expect(() => demo({ url: "https://example.com", ...extra } as unknown as DemoOptions, async () => {}), JSON.stringify(extra)).toThrow(DemoConfigError);
      expect(() => demo({ url: "https://example.com", ...extra } as unknown as DemoOptions, async () => {}), JSON.stringify(extra)).toThrow(message);
    }
  });

  it("rejects unquoted values that YAML would change, and files that show nothing", () => {
    for (const value of ["02134", "1.10", "0x1F", "1e3", "12345678901234567890", "true"]) {
      expect(() => parseYamlDemo(`url: http://x.test\nsteps:\n  - fill: Zip\n    value: ${value}\n    caption: Type\n`), value).toThrow(/value must be in quotes/);
    }
    expect(() => parseYamlDemo("url: http://x.test\nsteps:\n  - wait: 100\n  - chapter: One\n")).toThrow(/at least one step that shows a screen/);
    expect(() => parseYamlDemo('url: http://x.test\nsteps:\n  - select: Plan\n    option: 3\n    caption: Choose\n')).toThrow(/needs an option/);
    expect(() => parseYamlDemo("url: http://x.test\nsteps:\n  - press: Enter\n    caption: Go\n")).toThrow(/on \(the element that receives the key\)/);
  });

  it("rejects a caption too long to sit beside what it points at", async () => {
    const error = await runDemo(demo({ url: `${base}/index.html`, scale: 1 }, async ({ step }) => step.note("x".repeat(300)))).catch((e) => e);
    expect(error.message).toMatch(/300 characters long; the limit is 280/);
    const empty = await runDemo(demo({ url: `${base}/index.html`, scale: 1 }, async ({ step }) => step.note("  "))).catch((e) => e);
    expect(empty.message).toMatch(/needs a caption/);
  });
});

describe("private text stays out of the file", () => {
  it("replace also covers attributes the screen does not show", async () => {
    const result = await build(
      `${HEAD}</head><body><h1 title="Real Customer Ltd">Real Customer Ltd</h1><img alt="Logo of Real Customer Ltd" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
       <p aria-label="Real Customer Ltd &amp; Sons" data-owner="Real Customer Ltd">Account</p><button id="go">Go</button></body></html>`,
      async ({ step }) => step.click("#go", "Go"),
      { replace: { "Real Customer Ltd": "Acme <Inc> & Co" } },
    );
    const html = renderHtml(result);
    expect(html).not.toContain("Real Customer");
    expect(result.steps[0]!.structure!.html).toContain("Acme &lt;Inc&gt; &amp; Co</h1>");
  });

  it("fails rather than leave replaced text on screen when it is split across elements", async () => {
    const error = await build(
      `${HEAD}</head><body><p>Real <b>Customer</b> Ltd</p><button id="go">Go</button></body></html>`,
      async ({ step }) => step.click("#go", "Go"),
      { replace: { "Real Customer Ltd": "Acme Inc" } },
    ).catch((e) => e);
    expect(error.message).toMatch(/“Real Customer Ltd” is still on screen after "replace"/);
  });

  it("covers a card number field that gives no hint of what it is", async () => {
    const result = await build(
      `${HEAD}</head><body><input id="a" value="4242 4242 4242 4242"><input id="cardNumberField" value="1234"><input id="plain" value="1234 5678 9012 3456"><button id="go">Go</button></body></html>`,
      async ({ step }) => step.click("#go", "Go"),
    );
    const html = renderHtml(result);
    expect(html).not.toContain("4242 4242");
    expect(html).not.toContain('value="1234"');
    // Sixteen digits that are not a valid card number are left alone.
    expect(html).toContain("1234 5678 9012 3456");
  });
});

describe("player", () => {
  it("shows the chapter, and always exposes the caption to screen readers", async () => {
    const result = await runDemo(
      parseYamlDemo(`url: ${base}/index.html\nscale: 1\ntitle: Tour\nsteps:\n  - note: Welcome aboard\n  - chapter: Reports\n  - click: Reports\n    caption: Open your reports\n`),
    );
    const page = await openDemo(result);
    try {
      expect(await page.locator(".dk-sr").textContent()).toBe("Welcome aboard");
      expect(await page.locator(".dk-title").textContent()).toBe("Tour");
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => page.locator(".dk-title").textContent()).toBe("Tour · Reports");
      expect(await page.locator(".dk-sr").textContent()).toBe("Reports. Open your reports");
    } finally {
      await page.context().close();
    }
  });

  it("moves one screen for a double-click on the hotspot", async () => {
    const result = await runDemo(
      parseYamlDemo(`url: ${base}/index.html\nscale: 1\nsteps:\n  - click: Home\n    caption: One\n  - click: Home\n    caption: Two\n  - click: Home\n    caption: Three\n`),
    );
    const page = await openDemo(result);
    try {
      await page.locator(".dk-hot").dblclick();
      await page.waitForTimeout(300);
      expect(await page.locator(".dk-count").textContent()).toBe("2 / 4");
    } finally {
      await page.context().close();
    }
  });

  it("keeps a long caption inside the stage and off the element it points at", async () => {
    const caption = "This is a long caption that explains the button in some detail. ".repeat(4).trim();
    const result = await build(
      `${HEAD}</head><body><div style="height:330px"></div><button id="mid" style="margin-left:480px;padding:20px 60px">Middle</button></body></html>`,
      async ({ step }) => step.click("#mid", caption),
    );
    for (const width of [1320, 900, 600, 380]) {
      const page = await openDemo(result, { viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        await page.waitForTimeout(150);
        const stage = (await page.locator(".dk-stage").boundingBox())!;
        const hot = (await page.locator(".dk-hot").boundingBox())!;
        const cap = (await page.locator(".dk-cap").boundingBox())!;
        expect(cap.y, `width ${width}`).toBeGreaterThanOrEqual(stage.y - 0.5);
        expect(cap.y + cap.height, `width ${width}`).toBeLessThanOrEqual(stage.y + stage.height + 0.5);
        const apart = cap.x + cap.width <= hot.x || hot.x + hot.width <= cap.x || cap.y + cap.height <= hot.y || hot.y + hot.height <= cap.y;
        if (width >= 600) expect(apart, `caption overlaps the hotspot at width ${width}`).toBe(true);
      } finally {
        await page.context().close();
      }
    }
  });
});

describe("recorder", () => {
  async function record(html: string, act: (page: Page) => Promise<void>): Promise<{ steps: RecordedStep[]; url: string; stop: () => Promise<void> }> {
    const served = await servePage(html);
    const context = await browser.newContext();
    const steps: RecordedStep[] = [];
    await attachRecorder(context, (step) => steps.push(step));
    const page = await context.newPage();
    await page.goto(served.url);
    await act(page);
    await page.waitForTimeout(150);
    await context.close();
    return { steps: tidy(steps), url: served.url, stop: served.stop };
  }

  it("records choosing from a list, Enter without a button, rich text and a double-click, and they replay", async () => {
    const html = `${HEAD}</head><body>
      <label for="plan">Plan</label><select id="plan"><option>Free</option><option>Team</option></select>
      <form id="f" onsubmit="document.getElementById('out').textContent='searched '+document.getElementById('q').value;return false"><label for="q">Search</label><input id="q"></form>
      <div id="msg" contenteditable="true" aria-label="Message" style="border:1px solid #999;min-height:24px"></div>
      <button id="zoom" ondblclick="document.getElementById('out2').textContent='zoomed'">Zoom</button>
      <p id="out"></p><p id="out2"></p></body></html>`;
    const { steps, url, stop } = await record(html, async (page) => {
      await page.selectOption("#plan", "Team");
      await page.locator("#q").fill("boots");
      await page.locator("#q").press("Enter");
      await page.locator("#msg").click();
      await page.keyboard.type("Hello there");
      await page.locator("#zoom").dblclick();
    });
    try {
      expect(steps).toEqual([
        { kind: "select", target: "Plan", value: "Team" },
        { kind: "fill", target: "Search", value: "boots" },
        { kind: "press", target: "Search", value: "Enter" },
        { kind: "fill", target: "Message", value: "Hello there" },
        { kind: "dblclick", target: "Zoom" },
      ]);
      const replayed = await runDemo(parseYamlDemo(toStepsFile(url, steps).replace("title:", "scale: 1\ntitle:")));
      const last = replayed.steps[replayed.steps.length - 1]!.structure!.html;
      expect(last).toContain("searched boots");
      expect(last).toContain("zoomed");
      expect(last).toContain("Hello there");
      expect(last).toMatch(/<option selected="">Team/);
    } finally {
      await stop();
    }
  });

  it("never writes a password, even after it is switched to visible text", async () => {
    const { steps, stop } = await record(
      `${HEAD}</head><body><label for="pw">Password</label><input id="pw" type="password"><button id="show" onclick="document.getElementById('pw').type='text'">Show password</button>
       <label for="tok">API token</label><input id="tok" name="api_token"></body></html>`,
      async (page) => {
        await page.locator("#pw").click();
        await page.keyboard.type("hunter2-real-secret");
        await page.locator("#show").click();
        await page.locator("#pw").fill("hunter2-real-secret!");
        await page.locator("#tok").fill("abc123tokenvalue");
        await page.locator("#show").focus();
      },
    );
    await stop();
    const written = toStepsFile("http://x.test", steps);
    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("abc123tokenvalue");
    expect(steps.filter((s) => s.kind === "fill").map((s) => s.value)).toEqual(["${DEMO_PASSWORD}", "${DEMO_PASSWORD}", "${DEMO_PASSWORD}"]);
  });

  it("names checkboxes by their label, ignores text styling, and uses a selector when a name is shared", async () => {
    const html = `${HEAD}<style>#save{text-transform:uppercase}</style></head><body>
      <label><input type="checkbox" id="news"> Send me news</label>
      <label><input type="radio" name="bill" value="yearly"> Yearly</label>
      <button id="save">Save</button>
      <ul><li>One <button class="del">Delete</button></li><li>Two <button class="del">Delete</button></li></ul><p id="out"></p>
      <script>document.querySelectorAll(".del").forEach(function (b, i) { b.addEventListener("click", function () { document.getElementById("out").textContent = "deleted " + (i + 1); }); });</script></body></html>`;
    const { steps, url, stop } = await record(html, async (page) => {
      await page.locator("#news").check();
      await page.getByLabel("Yearly").check();
      await page.locator("#save").click();
      await page.locator(".del").nth(1).click();
    });
    try {
      expect(steps.slice(0, 3)).toEqual([
        { kind: "click", target: "Send me news" },
        { kind: "click", target: "Yearly" },
        { kind: "click", target: "Save" },
      ]);
      expect(steps[3]!.target).toMatch(/^css=/);
      const replayed = await runDemo(parseYamlDemo(toStepsFile(url, steps).replace("title:", "scale: 1\ntitle:")));
      const last = replayed.steps[replayed.steps.length - 1]!.structure!.html;
      expect(last).toContain("deleted 2");
      expect(last).toMatch(/id="news"[^>]*checked=""/);
    } finally {
      await stop();
    }
  });
});

describe("command line", () => {
  it("refuses options that do not apply, extra names, and unknown commands", async () => {
    const out = () => {};
    await expect(main(["build", "x.yaml", "--port", "5"], out)).rejects.toThrow(/--port does not apply to "build"/);
    await expect(main(["build", "x.yaml", "--baseline", "b"], out)).rejects.toThrow(/--baseline does not apply to "build"/);
    await expect(main(["preview", "x.html", "--headed"], out)).rejects.toThrow(/--headed does not apply to "preview"/);
    await expect(main(["init", "a.ts", "b.ts"], out)).rejects.toThrow(/extra: b\.ts/);
    await expect(main(["launch"], out)).rejects.toThrow(/Unknown command "launch"/);
    const lines: string[] = [];
    expect(await main(["help"], (line) => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toContain("demokiln check [script]");
    for (const flag of ["--headed", "--no-visual", "--baseline", "--report", "--no-baseline", "--port", "--output"]) expect(lines.join("\n")).toContain(flag);
  });

  it("init writes a steps file for a .yaml name, and explains a missing folder", async () => {
    const dir = temp();
    const file = join(dir, "tour.yaml");
    expect(await main(["init", file], () => {})).toBe(0);
    const written = readFileSync(file, "utf8");
    expect(() => parseYamlDemo(written)).not.toThrow();
    await expect(main(["init", file], () => {})).rejects.toThrow(/already exists/);
    await expect(main(["init", join(dir, "nowhere", "demo.ts")], () => {})).rejects.toThrow(/does not exist\. Create it first/);
    await expect(main(["init", join(dir, "demo.txt")], () => {})).rejects.toThrow(/must end in/);
    expect(await main(["init", join(dir, "demo.ts")], () => {})).toBe(0);
    expect(readFileSync(join(dir, "demo.ts"), "utf8")).toContain('import { demo } from "demokiln"');
  });

  it("preview of one demo serves that file and nothing beside it", async () => {
    const dir = temp();
    writeFileSync(join(dir, "demo.html"), "the demo");
    writeFileSync(join(dir, "demo.yaml"), "private steps");
    const { server, url } = await serveStatic(dir, 0, "demo.html");
    try {
      expect(await (await fetch(`${url}/demo.html`)).text()).toBe("the demo");
      expect((await fetch(`${url}/demo.yaml`)).status).toBe(404);
      expect((await fetch(`${url}/`)).status).toBe(404);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
    expect(existsSync(join(dir, "demo.yaml"))).toBe(true);
  });

  it("says plainly how many screens are real pages", async () => {
    const dir = temp();
    const script = join(dir, "demo.yaml");
    writeFileSync(script, `url: ${base}/widget.html\nscale: 1\nsteps:\n  - click: OK\n    caption: Press OK\n`);
    const lines: string[] = [];
    expect(await main(["build", script, "-o", join(dir, "demo.html")], (line) => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toContain("All 2 screens are screenshots.");
    expect(lines.join("\n")).not.toContain("the rest");
  });
});

describe("pixels", () => {
  it("draws nothing odd: an exported image keeps its size", async () => {
    const result = await runDemo(demo({ url: `${base}/index.html`, scale: 2 }, async ({ step }) => step.note("Home")));
    const png = PNG.sync.read(result.steps[0]!.image);
    expect([png.width, png.height]).toEqual([2560, 1600]);
    expect(result.scale).toBe(2);
    expect(Number.isNaN(Date.parse(result.time))).toBe(false);
  });
});

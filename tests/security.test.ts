import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachRecorder, demo, parseYamlDemo, readBaseline, renderHtml, runDemo, SecretFoundError, toStepsFile, writeBaseline, type RecordedStep } from "../src/index.js";
import { main, printable } from "../src/cli/index.js";
import { serveStatic } from "../src/cli/serve.js";
import { startFixture } from "./helpers.js";

// Regression tests for defects found by independent attack testing.

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
const close = (server: Server) => new Promise<void>((done) => server.close(() => done()));

async function servePage(html: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const dir = temp();
  writeFileSync(join(dir, "index.html"), html);
  const { server, url } = await serveStatic(dir);
  return { url: `${url}/index.html`, stop: () => close(server) };
}

const key = (prefix: string, rest: string) => prefix + rest;

describe("the build never requests an address just because a page names it", () => {
  it("embeds only what the browser itself loaded", async () => {
    const hits: string[] = [];
    const sentinel = createServer((request, response) => {
      hits.push(request.url ?? "");
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    });
    await new Promise<void>((done) => sentinel.listen(0, "127.0.0.1", () => done()));
    const port = (sentinel.address() as { port: number }).port;
    const internal = `http://127.0.0.1:${port}`;
    // Rules that never apply and an image the page never shows: a browser does not load these.
    const page = await servePage(
      `<!doctype html><meta charset="utf-8"><style>
        .never-used{background:url(${internal}/unused-background.png)}
        @font-face{font-family:Ghost;src:url(${internal}/unused-font.woff2)}
        @media (max-width:1px){body{background:url(${internal}/unused-media.png)}}
      </style><h1>Page</h1><button id="go">Go</button><template><img src="${internal}/in-template.png"></template>`,
    );
    try {
      const result = await runDemo(demo({ url: page.url, scale: 1 }, async ({ step }) => step.click("#go", "Go")));
      expect(hits).toEqual([]);
      expect(renderHtml(result)).not.toContain(String(port));
    } finally {
      await page.stop();
      await close(sentinel);
    }
  });
});

describe("credential scan", () => {
  const build = (body: string, extra: Record<string, unknown> = {}) =>
    servePage(`<!doctype html><meta charset="utf-8">${body}<p><button id="go">Go</button></p>`).then(async (page) => {
      try {
        return await runDemo(demo({ url: page.url, scale: 1, ...extra }, async ({ step }) => step.click("#go", "Go")));
      } finally {
        await page.stop();
      }
    });

  it("sees a credential split across neighbouring elements", async () => {
    const error = await build(`<p>Token: <span>${key("sk-ant-", "")}</span><b>api03-</b><span>${"A".repeat(26)}</span></p>`).catch((e) => e);
    expect(error).toBeInstanceOf(SecretFoundError);
    expect(error.message).toContain("Anthropic API key");
  });

  it("sees a credential shown through a style's ::before or ::after text", async () => {
    for (const which of ["before", "after"]) {
      const error = await build(`<style>#k::${which}{content:"${key("ghp_", "Qq11".repeat(9))}"}</style><p id="k">Key: </p>`).catch((e) => e);
      expect(error, which).toBeInstanceOf(SecretFoundError);
      expect(error.message).toContain("GitHub token");
    }
  });

  it("still passes when the split credential is masked, and leaves it out of the file", async () => {
    const result = await build(`<p id="t"><span>${key("sk-ant-", "")}</span><span>api03-${"A".repeat(26)}</span></p>`, { mask: ["#t"] });
    expect(renderHtml(result)).not.toContain("api03-AAAA");
  });

  it("does not join text across separate lines into a false alarm", async () => {
    const result = await build(`<div>the key starts with sk-ant-</div><div>${"a".repeat(30)} is unrelated text</div><p>disk-usage and <b>task</b>-force</p>`);
    expect(result.steps).toHaveLength(2);
  });
});

describe("symbolic links", () => {
  it("preview does not follow a link out of its folder", async () => {
    const outside = join(temp(), "secret.txt");
    writeFileSync(outside, "OUTSIDE-CONTENTS");
    const dir = temp();
    writeFileSync(join(dir, "demo.html"), "inside");
    try {
      symlinkSync(outside, join(dir, "leak.html"));
    } catch {
      return; // links cannot be created here (some Windows setups)
    }
    const { server, url } = await serveStatic(dir);
    try {
      expect(await (await fetch(`${url}/demo.html`)).text()).toBe("inside");
      const leaked = await fetch(`${url}/leak.html`);
      expect(leaked.status).toBe(404);
      expect(await leaked.text()).not.toContain("OUTSIDE-CONTENTS");
    } finally {
      await close(server);
    }
  });

  it("check refuses a baseline image that is a link", async () => {
    const result = await runDemo(demo({ url: `${base}/index.html`, scale: 1 }, async ({ step }) => step.note("Home")));
    const dir = join(temp(), "demo.baseline");
    writeBaseline(dir, result);
    const outside = join(temp(), "other.png");
    writeFileSync(outside, readFileSync(join(dir, "step-001.png")));
    const { rmSync } = await import("node:fs");
    rmSync(join(dir, "step-001.png"));
    try {
      symlinkSync(outside, join(dir, "step-001.png"));
    } catch {
      return;
    }
    expect(() => readBaseline(dir)).toThrow(/not an ordinary file/);
  });
});

describe("recorder", () => {
  it("never writes a password even when the page reports it as ordinary text, and neutralises ${...}", async () => {
    const context = await browser.newContext();
    const steps: RecordedStep[] = [];
    await attachRecorder(context, (step) => steps.push(step));
    const page = await context.newPage();
    await page.goto(`${base}/account.html`);
    await page.evaluate(() => {
      const send = (window as unknown as { __demokilnRecord: (s: string) => void }).__demokilnRecord;
      const typed = (document.getElementById("pw") as HTMLInputElement).value;
      send(JSON.stringify({ kind: "fill", target: "Notes", value: typed }));
      send(JSON.stringify({ kind: "fill", target: "Name", value: "${HOME} and $PATH" }));
      send(JSON.stringify({ kind: "click", target: "Save\u001b[31m" }));
    });
    await expect.poll(() => steps.length).toBe(2);
    await context.close();
    expect(steps[0]).toEqual({ kind: "fill", target: "Notes", value: "${DEMO_PASSWORD}" });
    expect(steps[1]!.value).toBe("$${HOME} and $$PATH");
    const file = toStepsFile("http://x.test", steps);
    expect(file).not.toContain("hunter2");
    // Read back, the recorded text is typed literally: no environment variable is consulted.
    process.env.DEMO_PASSWORD = "pw";
    expect(() => parseYamlDemo(file)).not.toThrow();
    delete process.env.DEMO_PASSWORD;
  });

  it("reads $$ in a steps file as a literal dollar sign", async () => {
    const result = await runDemo(
      parseYamlDemo(`url: ${base}/reports.html\nscale: 1\nsteps:\n  - fill: From\n    value: "$\${HOME}"\n    caption: Type\n  - note: Typed\n`),
    );
    expect(result.steps).toHaveLength(3);
    const html = renderHtml(result);
    expect(html).toContain("${HOME}");
    expect(html).not.toContain(process.env.HOME ?? "/Users/");
  });
});

describe("terminal output", () => {
  it("strips control sequences from everything the command line prints", async () => {
    expect(printable("ok\u001b[31m red \u001b]0;title\u0007 \u009b2K end\ttab\nline")).toBe("ok[31m red ]0;title 2K end\ttab\nline");
    const dir = temp();
    mkdirSync(join(dir, "o"));
    const script = join(dir, "demo.yaml");
    writeFileSync(script, `url: ${base}/index.html\nscale: 1\ntitle: "T\\e[31m"\nsteps:\n  - note: "pwn\\e[31m\\e]0;HIJACK\\a"\n`);
    const lines: string[] = [];
    expect(await main(["build", script, "-o", join(dir, "o", "demo.html")], (line) => lines.push(line))).toBe(0);
    const printed = lines.join("\n");
    expect(printed).toContain("pwn[31m");
    for (const char of printed) expect(char.codePointAt(0)! >= 32 || char === "\n" || char === "\t").toBe(true);
  });
});

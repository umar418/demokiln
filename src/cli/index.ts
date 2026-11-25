#!/usr/bin/env node
import { existsSync, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { embedSnippet, renderHtml, VERSION } from "../build/html.js";
import { baselineDirFor, compareWithBaseline, describeSize, readBaseline, renderCheckReport, writeBaseline } from "../check/check.js";
import { exportDemo } from "../export/export.js";
import { attachRecorder, toStepsFile, type RecordedStep } from "../script/record.js";
import { runDemo } from "../capture/run.js";
import { loadScript } from "../script/load.js";
import { serveStatic } from "./serve.js";

const HELP = `Demokiln ${VERSION} — interactive product demos built from a script.

Usage:
  demokiln init [file]             Create a starter demo (default: demo.ts; name it .yaml for a plain steps file)
  demokiln record <url>            Click through your app in a browser and get a steps file
      -o, --output <file>          Where to write the steps (default: demo.yaml)
  demokiln build [script]          Run the script and write the demo (default: demo.ts)
      -o, --output <file>          Where to write the demo (default: demo.html)
      --headed                     Show the browser while capturing
      --no-baseline                Do not record screenshots for "check" to compare against
  demokiln check [script]          Re-run the script and report whether the demo is out of date
      --baseline <folder>          Screens from the last build (default: demo.baseline)
      --report <file>              Before-and-after page, written when screens changed (default: demo.check.html)
      --no-visual                  Only check that every step still works
      --headed                     Show the browser while it runs
  demokiln export [script]         Write a step-by-step guide, images and a JSON description
      -o, --output <folder>        Where to write them (default: demo-export)
      --headed                     Show the browser while capturing
  demokiln preview [file]          Serve a built demo on this machine (default: demo.html)
      -p, --port <number>          Port to use (default: any free port)
  demokiln doctor                  Check that the browser needed for capture is installed
  demokiln --version | --help

Exit codes: 0 success, 1 a step failed or something is wrong, 2 "check" found the demo out of date.
`;

const STARTER = `import { demo } from "demokiln";

export default demo(
  {
    url: "http://localhost:3000",
    title: "A quick tour",
    // mask: [".customer-email"],            // cover private parts of the screen
    // replace: { "Real Customer Ltd": "Acme Inc" },
    // cta: { label: "Start free", url: "https://example.com/signup" },
  },
  async ({ page, step }) => {
    // Setup that should not appear in the demo, such as signing in:
    // await step.hidden(async () => {
    //   await page.getByLabel("Email").fill(process.env.DEMO_EMAIL ?? "");
    // });

    await step.note("Welcome. This tour takes about a minute.");
    await step.click(page.getByRole("link", { name: "Reports" }), "Open your reports");
  },
);
`;

const STARTER_YAML = `# A Demokiln steps file. Build it with: demokiln build <this file>
url: http://localhost:3000
title: A quick tour
# mask: [".customer-email"]        # cover private parts of the screen
# replace:
#   Real Customer Ltd: Acme Inc
steps:
  - note: Welcome. This tour takes about a minute.
  - click: Reports
    caption: Open your reports
`;

/** Options each command accepts. Anything else is a mistake and is refused. */
const ALLOWED: Record<string, string[]> = {
  init: [],
  record: ["output"],
  build: ["output", "headed", "no-baseline"],
  check: ["baseline", "report", "no-visual", "headed"],
  export: ["output", "headed"],
  preview: ["port"],
  doctor: [],
};

/** Removes terminal control sequences, so text from a page or a steps file cannot drive the terminal. */
export function printable(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 10 || code === 9 || (code >= 32 && code !== 127 && !(code >= 128 && code <= 159))) out += char;
  }
  return out;
}

export async function main(argv: string[], write: (line: string) => void = console.log): Promise<number> {
  const out = (line: string) => write(printable(line));
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      port: { type: "string", short: "p" },
      headed: { type: "boolean" },
      baseline: { type: "string" },
      report: { type: "string" },
      "no-baseline": { type: "boolean" },
      "no-visual": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, argument, ...extra] = positionals;
  if (values.version) return out(VERSION), 0;
  if (values.help || command === "help") return out(HELP), 0;
  if (!command) return out(HELP), 1;
  const allowed = ALLOWED[command];
  if (!allowed) throw new Error(`Unknown command "${command}". Run "demokiln --help".`);
  if (extra.length > 0) throw new Error(`"${command}" takes one name, but got extra: ${extra.join(" ")}`);
  for (const flag of Object.keys(values)) {
    if (!allowed.includes(flag)) throw new Error(`--${flag} does not apply to "${command}". Run "demokiln --help" to see what each command accepts.`);
  }

  if (command === "init") {
    const file = resolve(argument ?? "demo.ts");
    if (existsSync(file)) throw new Error(`${file} already exists. Nothing was changed.`);
    if (!existsSync(dirname(file))) throw new Error(`The folder ${dirname(file)} does not exist. Create it first.`);
    const yaml = /\.ya?ml$/i.test(file);
    if (!yaml && !/\.(ts|mts|js|mjs)$/i.test(file)) throw new Error("The file name must end in .ts, .js, .yaml or .yml.");
    await writeFile(file, yaml ? STARTER_YAML : STARTER, { flag: "wx" });
    out(`Created ${file}. Edit the steps, then run: demokiln build ${basename(file)}`);
    return 0;
  }

  if (command === "build") {
    const script = argument ?? "demo.ts";
    const definition = await loadScript(script);
    const result = await runDemo(definition, {
      headless: !values.headed,
      onStep: (number, step) => out(`  ${number}. ${step.kind === "end" ? "closing screen" : step.caption}`),
    });
    const html = renderHtml(result);
    const target = resolve(values.output ?? "demo.html");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, html);
    for (const [i, step] of result.steps.entries()) {
      for (const note of step.notes) out(`  Screen ${i + 1}: ${note}`);
      for (const warning of step.warnings) out(`  Warning, screen ${i + 1}: ${warning}`);
    }
    const total = result.steps.length;
    const kept = result.steps.filter((step) => step.structure).length;
    if (kept === total) out(`  All ${total} screens kept as real pages (sharp at any size).`);
    else if (kept === 0) out(`  All ${total} screens are screenshots.`);
    else out(`  ${kept} of ${total} screens kept as real pages (sharp at any size); the other ${total - kept} are screenshots.`);
    out(`Wrote ${target} (${total} screens, ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)`);
    if (!values["no-baseline"]) {
      const dir = baselineDirFor(target);
      writeBaseline(dir, result, basename(script));
      out(`Recorded ${dir} so "demokiln check" can tell when the demo goes out of date.`);
    }
    out(`To place it on a page:\n  ${embedSnippet(basename(target), result)}`);
    return 0;
  }

  if (command === "check") {
    const script = argument ?? "demo.ts";
    const definition = await loadScript(script);
    if (values["no-visual"]) {
      // A step that no longer works throws here, which ends the command with exit code 1.
      const result = await runDemo(definition, { headless: !values.headed });
      out(`All ${result.steps.length - 1} steps still work. Screens were not compared (--no-visual).`);
      return 0;
    }
    const baselineDir = resolve(values.baseline ?? "demo.baseline");
    const baseline = readBaseline(baselineDir);
    // Only the default folder is second-guessed; a folder the person named is taken at their word.
    if (values.baseline === undefined && baseline.manifest.script && baseline.manifest.script !== basename(script)) {
      throw new Error(
        `${baselineDir} belongs to ${baseline.manifest.script}, not ${basename(script)}. Point --baseline at the folder written when ${basename(script)} was built.`,
      );
    }
    // The app is shown the same date and time as in the last build, so a clock on screen is not a change.
    const result = await runDemo(definition, { headless: !values.headed, time: definition.options.time ?? baseline.manifest.time });
    out(`All ${result.steps.length - 1} steps still work.`);
    const changes = compareWithBaseline(baseline, result);
    if (changes.length === 0) return out("Every screen matches the last build. The demo is up to date."), 0;
    // A screen that differs may show something that changes by itself (a time or a random value
    // made by the server). Capturing once more tells that apart from a real change to the app.
    const different = changes.filter((change) => change.kind === "looks different");
    const restless = new Set<number>();
    if (different.length > 0) {
      const again = await runDemo(definition, { headless: !values.headed, time: result.time });
      for (const change of different) {
        const first = result.steps[change.number - 1]?.image;
        const second = again.steps[change.number - 1]?.image;
        if (first && second && !first.equals(second)) restless.add(change.number);
      }
    }
    for (const change of changes) {
      out(change.number === 0 ? `  ${change.caption}` : `  Screen ${change.number}: ${change.kind}${describeSize(change)} — ${change.caption}`);
      if (change.kind === "looks different" && restless.has(change.number)) {
        out(`    This screen also differed between two captures made moments apart, so part of it changes by itself`);
        out(`    (a time, a counter, random data). Cover that part with "mask", or this screen will always be reported.`);
      }
    }
    const report = resolve(values.report ?? "demo.check.html");
    await mkdir(dirname(report), { recursive: true });
    await writeFile(report, renderCheckReport(result.title, changes));
    out(`The demo is out of date. Before-and-after: ${report}`);
    out(`Rebuild with: demokiln build ${script}`);
    return 2;
  }

  if (command === "export") {
    const definition = await loadScript(argument ?? "demo.ts");
    const result = await runDemo(definition, { headless: !values.headed });
    const dir = resolve(values.output ?? "demo-export");
    const { files } = exportDemo(result, dir);
    out(`Wrote ${files.length} files to ${dir} (guide.md, demo.json and ${result.steps.length} images).`);
    return 0;
  }

  if (command === "record") {
    if (!argument || !/^https?:\/\//i.test(argument)) throw new Error("record needs the address of your app, for example: demokiln record http://localhost:3000");
    const target = resolve(values.output ?? "demo.yaml");
    if (existsSync(target)) throw new Error(`${target} already exists. Choose another name with --output.`);
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: null });
    const steps: RecordedStep[] = [];
    await attachRecorder(context, (step) => {
      steps.push(step);
      out(`  ${step.kind} ${step.target}`);
    });
    const page = await context.newPage();
    await page.goto(argument);
    out("Recording. Click through your app, then close the browser window to finish.");
    await new Promise<void>((done) => {
      page.once("close", () => done());
      browser.once("disconnected", () => done());
    });
    await browser.close().catch(() => {});
    if (steps.length === 0) return out("Nothing was recorded, so no file was written."), 1;
    await writeFile(target, toStepsFile(argument, steps), { flag: "wx" });
    out(`Wrote ${target} with ${steps.length} recorded actions. Reword the captions, then run: demokiln build ${basename(target)}`);
    return 0;
  }

  if (command === "preview") {
    const file = resolve(argument ?? "demo.html");
    if (!existsSync(file)) throw new Error(`No file at ${file}. Run "demokiln build" first.`);
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a number between 0 and 65535.");
    let served;
    try {
      // A demo is one file, so only that file is served, not its neighbours. A folder serves itself.
      served = await serveStatic(statSync(file).isDirectory() ? file : dirname(file), port, statSync(file).isDirectory() ? undefined : basename(file));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "EADDRINUSE") throw new Error(`Port ${port} is already in use. Choose another with --port, or leave it out to use any free port.`);
      if (code === "EACCES") throw new Error(`Port ${port} is not allowed. Choose a port above 1023.`);
      throw error;
    }
    out(`Preview: ${served.url}/${statSync(file).isDirectory() ? "" : encodeURIComponent(basename(file))}  (Ctrl+C to stop)`);
    await new Promise(() => {});
  }

  // doctor
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const version = browser.version();
    await browser.close();
    out(`Browser for capture: ready (Chromium ${version}).`);
    return 0;
  } catch (error) {
    out("Browser for capture: not ready.");
    out(`  ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    out("  Fix: npm install playwright && npx playwright install chromium");
    return 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(printable(`Error: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    },
  );
}

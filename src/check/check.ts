import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Hotspot, RunResult, StepKind } from "../capture/run.js";
import { compareImages, isSameScreen } from "../capture/snapshot.js";

/** What the last build produced, kept so a later run can be compared with it. */
export interface Baseline {
  version: 2;
  /** File name of the script the demo was built from. */
  script: string;
  title: string;
  viewport: { width: number; height: number };
  scale: number;
  /** The date and time the app saw, so a re-run sees the same one. */
  time: string;
  /** Settings that change the demo without changing any screen. */
  settings: { accent: string | null; autoplay: number | null; cta: { label: string; url: string } | null };
  steps: { kind: StepKind; caption: string; chapter: string | null; hotspot: Hotspot | null; file: string }[];
}

const STEP_FILE = /^step-\d{3}\.png$/;

export function baselineDirFor(outputFile: string): string {
  return outputFile.replace(/\.html?$/i, "") + ".baseline";
}

export function writeBaseline(dir: string, result: RunResult, script = ""): void {
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a link. Choose a real folder for the baseline.`);
  // Only files this tool wrote are ever removed from the folder.
  for (const name of readdirSync(dir)) if (STEP_FILE.test(name) || name === "baseline.json") rmSync(join(dir, name));
  const steps = result.steps.map((step, index) => {
    const file = `step-${String(index + 1).padStart(3, "0")}.png`;
    writeFileSync(join(dir, file), step.image);
    return { kind: step.kind, caption: step.caption, chapter: step.chapter ?? null, hotspot: step.hotspot ?? null, file };
  });
  const manifest: Baseline = {
    version: 2,
    script,
    title: result.title,
    viewport: result.viewport,
    scale: result.scale,
    time: result.time,
    settings: { accent: result.accent ?? null, autoplay: result.autoplay ?? null, cta: result.cta ?? null },
    steps,
  };
  writeFileSync(join(dir, "baseline.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export function readBaseline(dir: string): { manifest: Baseline; images: Buffer[] } {
  const file = join(dir, "baseline.json");
  if (!existsSync(file)) throw new Error(`No baseline at ${dir}. Run "demokiln build" first; it records one next to the demo.`);
  let manifest: Baseline;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8")) as Baseline;
  } catch {
    throw new Error(`${file} is not valid JSON. Rebuild the demo to recreate it.`);
  }
  if ((manifest as { version?: number })?.version === 1) throw new Error(`${file} was written by an older version of Demokiln. Rebuild the demo to recreate it.`);
  if (manifest?.version !== 2 || !Array.isArray(manifest.steps) || !manifest.viewport || typeof manifest.time !== "string" || Number.isNaN(Date.parse(manifest.time))) {
    throw new Error(`${file} is not a Demokiln baseline. Rebuild the demo to recreate it.`);
  }
  if (manifest.steps.length === 0) throw new Error(`${file} lists no screens. Rebuild the demo to recreate it.`);
  const images = manifest.steps.map((step) => {
    // File names come from a file on disk, so they are checked before use.
    if (typeof step?.file !== "string" || !STEP_FILE.test(step.file)) throw new Error(`${file} names an unexpected file. Rebuild the demo to recreate it.`);
    const path = join(dir, step.file);
    if (!existsSync(path)) throw new Error(`${path} is missing. Rebuild the demo to recreate the baseline.`);
    // A link could point at any file on the machine, which would then be copied into the report.
    if (!lstatSync(path).isFile()) throw new Error(`${path} is not an ordinary file. Rebuild the demo to recreate the baseline.`);
    return readFileSync(path);
  });
  return { manifest, images };
}

export interface ScreenChange {
  /** Screen number, or 0 for a change to the demo as a whole. */
  number: number;
  caption: string;
  kind: "looks different" | "new screen" | "screen removed" | "caption changed" | "points somewhere else" | "chapter changed" | "kind of step changed" | "setting changed";
  /** Pixels that differ, for screens that look different. */
  pixels?: number;
  /** Share of pixels that differ, for screens that look different. */
  share?: number;
  before?: Buffer;
  after?: Buffer;
}

/** How much of the screen changed, in words a person can judge. */
export function describeSize(change: ScreenChange): string {
  if (change.share === undefined) return "";
  return change.share >= 0.0001 ? ` (${(change.share * 100).toFixed(2)}% of the screen)` : ` (${change.pixels ?? 0} pixels)`;
}

function decode(image: Buffer, what: string): PNG {
  try {
    return PNG.sync.read(image);
  } catch {
    throw new Error(`${what} is not a readable image. Rebuild the demo to recreate the baseline.`);
  }
}

/** Lists everything that no longer matches the last build. An empty list means the demo is current. */
export function compareWithBaseline(baseline: { manifest: Baseline; images: Buffer[] }, result: RunResult): ScreenChange[] {
  const { manifest } = baseline;
  // Screens captured at another size cannot be compared; saying "everything changed" would be untrue.
  if (manifest.viewport.width !== result.viewport.width || manifest.viewport.height !== result.viewport.height || manifest.scale !== result.scale) {
    throw new Error(
      `The baseline was built at ${manifest.viewport.width}×${manifest.viewport.height} (scale ${manifest.scale}) but the script now uses ` +
        `${result.viewport.width}×${result.viewport.height} (scale ${result.scale}). Rebuild the demo, or point --baseline at the right folder.`,
    );
  }
  const changes: ScreenChange[] = [];
  const setting = (name: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) changes.push({ number: 0, caption: `${name} changed`, kind: "setting changed" });
  };
  setting("The title", manifest.title, result.title);
  setting("The accent colour", manifest.settings?.accent, result.accent);
  setting("Autoplay", manifest.settings?.autoplay, result.autoplay);
  setting("The closing button", manifest.settings?.cta, result.cta);

  const moved = (a: Hotspot | null | undefined, b: Hotspot | null | undefined) => {
    if (!a || !b) return Boolean(a) !== Boolean(b);
    return (["x", "y", "w", "h"] as const).some((key) => Math.abs(a[key] - b[key]) > 0.002);
  };
  const count = Math.max(manifest.steps.length, result.steps.length);
  for (let i = 0; i < count; i++) {
    const old = manifest.steps[i];
    const now = result.steps[i];
    if (!old && now) {
      changes.push({ number: i + 1, caption: now.caption, kind: "new screen", after: now.image });
    } else if (old && !now) {
      changes.push({ number: i + 1, caption: String(old.caption), kind: "screen removed", before: baseline.images[i]! });
    } else if (old && now) {
      if (old.caption !== now.caption) changes.push({ number: i + 1, caption: now.caption, kind: "caption changed" });
      if (old.kind !== now.kind) changes.push({ number: i + 1, caption: now.caption, kind: "kind of step changed" });
      if ((old.chapter ?? null) !== (now.chapter ?? null)) changes.push({ number: i + 1, caption: now.caption, kind: "chapter changed" });
      if (moved(old.hotspot, now.hotspot)) changes.push({ number: i + 1, caption: now.caption, kind: "points somewhere else" });
      const fidelity = compareImages(decode(baseline.images[i]!, `Baseline image ${old.file}`), decode(now.image, "The new capture"));
      if (!isSameScreen(fidelity)) {
        changes.push({ number: i + 1, caption: now.caption, kind: "looks different", pixels: fidelity.pixels, share: fidelity.overall, before: baseline.images[i]!, after: now.image });
      }
    }
  }
  return changes;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A page showing each changed screen before and after. It contains no script and loads nothing. */
export function renderCheckReport(title: string, changes: ScreenChange[]): string {
  const picture = (label: string, image: Buffer | undefined) =>
    image ? `<figure><figcaption>${label}</figcaption><img alt="${label}" src="data:image/png;base64,${image.toString("base64")}"></figure>` : `<figure><figcaption>${label}</figcaption><p class="none">None</p></figure>`;
  const rows = changes
    .map((change) => {
      const share = describeSize(change);
      const images = change.before || change.after ? `<div class="pair">${picture("Last build", change.before)}${picture("Now", change.after)}</div>` : "";
      const heading = change.number === 0 ? "The demo" : `Screen ${change.number}`;
      return `<section><h2>${heading}: ${escapeHtml(change.kind)}${share}</h2><p>${escapeHtml(change.caption)}</p>${images}</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}: what changed</title>
<style>
body{margin:0;padding:24px;font:15px/1.5 system-ui,sans-serif;color:#111827;background:#f4f5f7}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 4px}section{background:#fff;border:1px solid #dfe3ea;border-radius:12px;padding:16px;margin-top:16px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}figure{margin:0}figcaption{font-size:12px;font-weight:600;color:#6b7280;margin-bottom:6px}
img{width:100%;display:block;border:1px solid #dfe3ea;border-radius:8px}.none{color:#6b7280;margin:0}p{margin:0}
@media(max-width:700px){.pair{grid-template-columns:1fr}}
@media(prefers-color-scheme:dark){body{background:#0e1116;color:#f3f4f6}section{background:#171b22;border-color:#2a303a}img{border-color:#2a303a}}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p>${changes.length} thing${changes.length === 1 ? " no longer matches" : "s no longer match"} the last build. Rebuild the demo to bring it up to date.</p>
${rows}
</body></html>
`;
}

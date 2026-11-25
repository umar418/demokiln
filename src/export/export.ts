import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { CapturedStep, RunResult } from "../capture/run.js";

/** Draws the hotspot outline onto a copy of a screenshot, so a still image shows where to click. */
export function annotate(step: CapturedStep, accent = "#4f46e5"): Buffer {
  if (!step.hotspot || step.kind === "end") return step.image;
  const png = PNG.sync.read(step.image);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16)) as [number, number, number];
  const thick = Math.max(2, Math.round(png.width / 400));
  const pad = thick * 2;
  const left = Math.max(0, Math.round(step.hotspot.x * png.width) - pad);
  const top = Math.max(0, Math.round(step.hotspot.y * png.height) - pad);
  const right = Math.min(png.width - 1, Math.round((step.hotspot.x + step.hotspot.w) * png.width) + pad);
  const bottom = Math.min(png.height - 1, Math.round((step.hotspot.y + step.hotspot.h) * png.height) + pad);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const edge = x - left < thick || right - x < thick || y - top < thick || bottom - y < thick;
      if (!edge) continue;
      const i = (png.width * y + x) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Text that is safe inside Markdown: nothing in a caption can become a link, image, heading or HTML. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+\-.!|~])/g, "\\$1");
}

export interface ExportSummary {
  files: string[];
}

/** Writes a step-by-step guide, one annotated image per screen, and a JSON description. */
export function exportDemo(result: RunResult, dir: string): ExportSummary {
  const imagesDir = join(dir, "images");
  mkdirSync(imagesDir, { recursive: true });
  const files: string[] = [];
  const names = result.steps.map((_step, index) => `step-${String(index + 1).padStart(2, "0")}.png`);
  result.steps.forEach((step, index) => {
    writeFileSync(join(imagesDir, names[index]!), annotate(step, result.accent));
    files.push(`images/${names[index]}`);
  });

  const lines = [`# ${escapeMarkdown(result.title)}`, ""];
  let chapter: string | undefined;
  let number = 0;
  result.steps.forEach((step, index) => {
    if (step.chapter && step.chapter !== chapter) {
      chapter = step.chapter;
      lines.push(`## ${escapeMarkdown(chapter)}`, "");
    }
    if (step.kind === "end") {
      lines.push(escapeMarkdown(step.caption), "", `![Result](images/${names[index]})`, "");
    } else {
      number++;
      lines.push(`${number}. ${escapeMarkdown(step.caption)}`, "", `   ![Step ${number}](images/${names[index]})`, "");
    }
  });
  writeFileSync(join(dir, "guide.md"), lines.join("\n"));
  files.push("guide.md");

  const description = {
    title: result.title,
    viewport: result.viewport,
    steps: result.steps.map((step, index) => ({
      number: index + 1,
      kind: step.kind,
      caption: step.caption,
      chapter: step.chapter ?? null,
      hotspot: step.hotspot ?? null,
      image: `images/${names[index]}`,
    })),
  };
  writeFileSync(join(dir, "demo.json"), JSON.stringify(description, null, 2) + "\n");
  files.push("demo.json");
  return { files };
}

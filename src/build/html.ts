import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RunResult } from "../capture/run.js";
import { FRAME_POLICY } from "../capture/snapshot.js";

export const VERSION = "0.0.1";

function asset(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../player/${name}`, import.meta.url)), "utf8");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("base64");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** JSON that is safe inside a <script> element: no "<" and no line separators that end a script early. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(String.fromCharCode(0x2028)).join("\\u2028")
    .split(String.fromCharCode(0x2029)).join("\\u2029");
}

/**
 * Builds the single self-contained demo file. The same input always gives the
 * same bytes: there are no timestamps or random values.
 */
export function renderHtml(result: RunResult): string {
  const css = asset("player.css").trim();
  const js = asset("player.js").trim();
  if (/<\/style/i.test(css) || /<\/script/i.test(js)) throw new Error("Player assets contain a closing tag.");

  const structured = result.steps.some((step) => step.structure);
  const data = {
    version: VERSION,
    title: result.title,
    width: result.viewport.width,
    height: result.viewport.height,
    accent: result.accent ?? null,
    cta: result.cta ?? null,
    autoplay: result.autoplay ?? null,
    styles: structured ? result.tables.styles : [],
    resources: structured ? result.tables.resources : [],
    steps: result.steps.map((step) => ({
      kind: step.kind,
      caption: step.caption,
      chapter: step.chapter ?? null,
      hotspot: step.hotspot ?? null,
      // A step carries either the page structure or the screenshot, never both.
      ...(step.structure
        ? { html: step.structure.html, scroll: step.structure.scroll }
        : { image: `data:image/png;base64,${step.image.toString("base64")}` }),
    })),
  };

  // Only this exact script may run and nothing may load from the network. Captured pages
  // bring their own styles, so styles are allowed inline when a demo contains one; styles
  // cannot run code, and images and fonts are still limited to data embedded in this file.
  const policy = structured
    ? `${FRAME_POLICY}; script-src 'sha256-${sha256(js)}'`
    : [
        "default-src 'none'",
        "img-src data:",
        `style-src 'sha256-${sha256(css)}'`,
        `script-src 'sha256-${sha256(js)}'`,
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="Demokiln ${VERSION}">`,
    `<title>${escapeHtml(result.title)}</title>`,
    `<style>${css}</style>`,
    "</head>",
    "<body>",
    '<div id="demokiln" class="dk"></div>',
    "<noscript>This interactive demo needs JavaScript.</noscript>",
    `<script type="application/json" id="demokiln-data">${safeJson(data)}</script>`,
    `<script>${js}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** Markup for placing a built demo on another page. The frame keeps the demo's shape at any width. */
export function embedSnippet(file: string, result: RunResult): string {
  const safe = file.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const title = result.title.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  // The player adds a title bar and controls of about 132px to the capture's own height.
  const ratio = `${result.viewport.width} / ${result.viewport.height + 132}`;
  return `<iframe src="${safe}" title="${title}" loading="lazy" style="width:100%;aspect-ratio:${ratio};border:0"></iframe>`;
}

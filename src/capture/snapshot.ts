import type { BrowserContext, ElementHandle, Page } from "playwright";
import { PNG } from "pngjs";
import { RES_TOKEN, sanitizeCss, sanitizeHtml, STYLE_TOKEN } from "../privacy/sanitize.js";
import { ALWAYS_MASKED } from "./page.js";

/** Styles and resources shared by every step of a demo, so each is stored once. */
export interface SharedTables {
  styles: string[];
  resources: string[];
  /** URL -> index into resources, so a file is embedded once per build. */
  fetched: Map<string, number>;
  bytes: number;
  /** Files the browser itself loaded while showing the app, by URL. */
  loaded: Map<string, LoadedFile>;
  loadedBytes: number;
}

export interface LoadedFile {
  type: string;
  body: Promise<Buffer | null>;
}

export function newTables(): SharedTables {
  return { styles: [], resources: ["data:,"], fetched: new Map(), bytes: 0, loaded: new Map(), loadedBytes: 0 };
}

const MAX_LOADED = 80 * 1024 * 1024;

/**
 * Remembers the images, fonts and stylesheets the browser loads. A copy of the page is built
 * only from these: the build never requests an address just because a page names it, so a
 * hostile page cannot use the build to reach other machines.
 */
export function watchResponses(context: BrowserContext, tables: SharedTables): void {
  context.on("response", (response) => {
    const request = response.request();
    if (!["image", "font", "stylesheet"].includes(request.resourceType())) return;
    const status = response.status();
    if (status < 200 || status >= 300 || tables.loaded.size >= 3000) return;
    const type = (response.headers()["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const body = response
      .body()
      .then((bytes) => {
        if (bytes.length > MAX_RESOURCE || tables.loadedBytes + bytes.length > MAX_LOADED) return null;
        tables.loadedBytes += bytes.length;
        return bytes;
      })
      .catch(() => null);
    // A redirected file is known by every address in its chain.
    for (let hop: ReturnType<typeof response.request> | null = request; hop; hop = hop.redirectedFrom()) {
      tables.loaded.set(hop.url().split("#")[0]!, { type, body });
    }
  });
}

export interface Snapshot {
  html: string;
  scroll: [number, number];
}

interface RawStyle {
  css?: string;
  href?: string;
  media?: string;
}

interface RawSnapshot {
  html: string;
  styles: RawStyle[];
  resources: string[];
  scroll: [number, number];
  problems: string[];
}

const MAX_RESOURCE = 4 * 1024 * 1024;
const MAX_TOTAL = 30 * 1024 * 1024;
const MAX_HTML = 6 * 1024 * 1024;

const FONT_TYPES: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject" };
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/;

/**
 * Runs inside the page. Returns a still copy of the document with every stylesheet
 * and resource replaced by a numbered placeholder. Nothing here is trusted by the
 * caller: the result is parsed and cleaned again outside the page.
 */
/* c8 ignore start */
function serializeInPage(args: {
  target: Element | null;
  maskSelectors: string[];
  alwaysMasked: string;
  maskColor: string;
  resToken: string;
  styleToken: string;
}): RawSnapshot {
  const problems: string[] = [];
  const resources: string[] = [];
  const seen = new Map<string, number>();
  const token = (url: string) => {
    if (!seen.has(url)) {
      seen.set(url, resources.length);
      resources.push(url);
    }
    return `${args.resToken}:${seen.get(url)}:`;
  };
  const absolute = (url: string, base: string) => {
    try {
      return new URL(url, base).href;
    } catch {
      return null;
    }
  };
  const rewriteCss = (css: string, base: string) =>
    css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g, (match, a, b, c) => {
      const raw = String(a ?? b ?? c ?? "").trim();
      if (!raw || raw.startsWith("data:") || raw.startsWith("#")) return match;
      const full = absolute(raw, base);
      if (!full || !/^https?:/.test(full)) {
        problems.push("a resource that is not on http or https");
        return 'url("data:,")';
      }
      return `url("${token(full)}")`;
    });

  const styles: RawStyle[] = [];
  // Conditions that depend on the viewer (screen density, touch, contrast, colour scheme, size)
  // are decided now, as they were when the screen was captured, so every viewer sees that screen.
  const decided = (condition: string) => {
    try {
      return matchMedia(condition).matches ? "all" : "not all";
    } catch {
      return "not all";
    }
  };
  // In a rule's selector, pointer and focus states become the attributes written on the copy.
  const stateful = (ruleText: string) => {
    const open = ruleText.indexOf("{");
    if (open < 0) return ruleText;
    const selector = ruleText
      .slice(0, open)
      .replace(/:focus-visible/g, "[data-dk-fv]")
      .replace(/:focus-within/g, "[data-dk-fw]")
      .replace(/:focus(?![-\w])/g, "[data-dk-f]")
      .replace(/:hover(?![-\w])/g, "[data-dk-h]");
    return selector + ruleText.slice(open);
  };
  const readRules = (rules: CSSRuleList, base: string, depth: number): string => {
    let out = "";
    for (const rule of Array.from(rules)) {
      if (rule.type === 3) {
        const imported = (rule as CSSImportRule).styleSheet;
        if (imported && depth < 5) {
          const media = (rule as CSSImportRule).media.mediaText;
          const text = readSheet(imported, depth + 1);
          out += media && media !== "all" ? `@media ${decided(media)}{${text}}` : text;
        }
      } else if (rule.type === 4) {
        const media = rule as CSSMediaRule;
        out += `@media ${decided(media.media.mediaText)}{${readRules(media.cssRules, base, depth)}}\n`;
      } else if (rule.type !== 1 && rule.type !== 7 && (rule as CSSGroupingRule).cssRules && depth < 12) {
        // Other wrappers (@supports, @layer, @container) keep their own condition.
        const text = rule.cssText;
        const open = text.indexOf("{");
        out += open > 0 ? `${text.slice(0, open)}{${readRules((rule as CSSGroupingRule).cssRules, base, depth + 1)}}\n` : rewriteCss(text, base) + "\n";
      } else if (rule.type === 1) {
        out += stateful(rewriteCss(rule.cssText, base)) + "\n";
      } else {
        out += rewriteCss(rule.cssText, base) + "\n";
      }
    }
    return out;
  };
  const readSheet = (sheet: CSSStyleSheet, depth: number): string => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return "";
    }
    return readRules(rules, sheet.href || document.baseURI, depth);
  };
  styles.push({ css: ":where([data-dk-fv]){outline:auto 1px -webkit-focus-ring-color}" });
  const sheets = [...Array.from(document.styleSheets), ...Array.from(document.adoptedStyleSheets ?? [])];
  for (const sheet of sheets) {
    if (sheet.disabled) continue;
    const media = sheet.media.mediaText;
    const applies = !media || media === "all" || decided(media) === "all";
    if (!applies) continue;
    let readable = true;
    try {
      void sheet.cssRules;
    } catch {
      readable = false;
    }
    if (readable) styles.push({ css: readSheet(sheet, 0) });
    else if (sheet.href) styles.push({ href: sheet.href });
  }

  const masked = new Set<Element>();
  for (const selector of [...args.maskSelectors, args.alwaysMasked]) {
    try {
      document.querySelectorAll(selector).forEach((e) => masked.add(e));
    } catch {
      /* reported by the capture step */
    }
  }
  const endless = new Set<Element>();
  for (const animation of document.getAnimations()) {
    const effect = animation.effect as KeyframeEffect | null;
    if (effect?.target && effect.getComputedTiming().iterations === Infinity) endless.add(effect.target);
  }

  const hovered = new Set<Element>(Array.from(document.querySelectorAll(":hover")));
  const active = document.activeElement;
  const focused = active && active !== document.body && active !== document.documentElement ? active : null;
  const focusVisible = Boolean(focused && focused.matches(":focus-visible"));
  const focusWithin = new Set<Element>();
  for (let e: Element | null = focused; e; e = e.parentElement) focusWithin.add(e);

  const root = document.documentElement;
  const clone = root.cloneNode(true) as HTMLElement;
  const originals = [root, ...Array.from(root.querySelectorAll("*"))];
  const copies = [clone, ...Array.from(clone.querySelectorAll("*"))];
  if (originals.length !== copies.length) problems.push("a page that changed while it was being copied");
  const remove: Element[] = [];
  const covers: DOMRect[] = [];
  const addStyle = (el: Element, css: string) => el.setAttribute("style", `${el.getAttribute("style") ?? ""};${css}`);

  for (let i = 0; i < Math.min(originals.length, copies.length); i++) {
    const original = originals[i] as HTMLElement;
    const copy = copies[i] as HTMLElement;
    const tag = original.tagName.toLowerCase();
    if (original.shadowRoot) problems.push("a web component with hidden internals (shadow DOM)");
    if (original === args.target) copy.setAttribute("data-dk-target", "");
    // A still copy has no pointer and no keyboard focus, so the states they cause are
    // written down as attributes; the styles are rewritten to match (see stateful below).
    if (hovered.has(original)) copy.setAttribute("data-dk-h", "");
    if (original === focused) {
      copy.setAttribute("data-dk-f", "");
      if (focusVisible) copy.setAttribute("data-dk-fv", "");
    }
    if (focusWithin.has(original)) copy.setAttribute("data-dk-fw", "");

    if (masked.has(original)) {
      // The element keeps its place but loses everything it contained, and a flat box is
      // drawn over exactly the area the screenshot covers.
      const rect = original.getBoundingClientRect();
      const display = getComputedStyle(original).display;
      for (const attr of Array.from(copy.attributes)) if (!["class", "id", "type"].includes(attr.name)) copy.removeAttribute(attr.name);
      copy.textContent = "";
      if (tag === "input" || tag === "textarea") copy.setAttribute("value", "");
      addStyle(
        copy,
        `visibility:hidden!important;box-sizing:border-box!important;width:${rect.width}px!important;height:${rect.height}px!important;` +
          (display === "inline" ? "display:inline-block!important;vertical-align:bottom!important;" : ""),
      );
      if (rect.width > 0 && rect.height > 0) covers.push(rect);
      continue;
    }

    if (tag !== "html") {
      if (original.scrollTop) copy.setAttribute("data-dk-st", String(original.scrollTop));
      if (original.scrollLeft) copy.setAttribute("data-dk-sl", String(original.scrollLeft));
    }
    if (endless.has(original)) addStyle(copy, "animation:none!important");

    if (tag === "input") {
      const input = original as HTMLInputElement;
      if (input.type === "checkbox" || input.type === "radio") {
        if (input.checked) copy.setAttribute("checked", "");
        else copy.removeAttribute("checked");
      } else if (input.type !== "file" && input.type !== "hidden") {
        copy.setAttribute("value", input.value);
      } else {
        copy.removeAttribute("value");
      }
    } else if (tag === "textarea") {
      copy.textContent = (original as HTMLTextAreaElement).value;
    } else if (tag === "option") {
      if ((original as HTMLOptionElement).selected) copy.setAttribute("selected", "");
      else copy.removeAttribute("selected");
    } else if (tag === "img") {
      const image = original as HTMLImageElement;
      const source = image.currentSrc || image.src;
      copy.removeAttribute("srcset");
      copy.removeAttribute("sizes");
      copy.removeAttribute("loading");
      if (source && !source.startsWith("data:")) {
        if (/^https?:/.test(source)) copy.setAttribute("src", token(source));
        else {
          copy.removeAttribute("src");
          problems.push("an image that is not on http or https");
        }
      }
    } else if (tag === "canvas") {
      try {
        const picture = document.createElement("img");
        for (const name of ["id", "class", "style"]) {
          const value = original.getAttribute(name);
          if (value) picture.setAttribute(name, value);
        }
        const rect = original.getBoundingClientRect();
        picture.setAttribute("src", (original as HTMLCanvasElement).toDataURL("image/png"));
        addStyle(picture, `width:${rect.width}px;height:${rect.height}px`);
        copy.replaceWith(picture);
      } catch {
        problems.push("a drawing surface (canvas) that cannot be copied");
      }
    } else if (["video", "audio", "iframe", "object", "embed", "frame"].includes(tag)) {
      problems.push(`an embedded ${tag}`);
      remove.push(copy);
    } else if (["script", "noscript", "base", "template", "link", "style", "source", "meta"].includes(tag)) {
      remove.push(copy);
    }

    const inline = copy.getAttribute("style");
    if (inline && inline.includes("url(")) copy.setAttribute("style", rewriteCss(inline, document.baseURI));
    for (const attr of Array.from(copy.attributes)) if (attr.name.startsWith("on")) copy.removeAttribute(attr.name);
  }
  for (const element of remove) element.remove();
  for (const rect of covers) {
    const box = document.createElement("div");
    box.setAttribute(
      "style",
      `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;` +
        `background:${args.maskColor};z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0`,
    );
    clone.appendChild(box);
  }

  const head = clone.querySelector("head") ?? clone.insertBefore(document.createElement("head"), clone.firstChild);
  const charset = document.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  head.insertBefore(charset, head.firstChild);
  styles.forEach((_style, index) => {
    const element = document.createElement("style");
    element.textContent = `${args.styleToken}:${index}:`;
    head.appendChild(element);
  });

  return { html: "<!doctype html>" + clone.outerHTML, styles, resources, scroll: [window.scrollX, window.scrollY], problems };
}
/* c8 ignore stop */

function rewriteUrls(css: string, base: string, register: (url: string) => string): string {
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g, (match, a, b, c) => {
    const raw = String(a ?? b ?? c ?? "").trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("#")) return match;
    try {
      const full = new URL(raw, base).href;
      if (/^https?:/.test(full)) return `url("${register(full)}")`;
    } catch {
      /* fall through */
    }
    return 'url("data:,")';
  });
}

/** Splits text at commas that are not inside parentheses or quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Picks the entry of an image-set() that the capture used, so the viewer's screen density cannot swap it. */
function pinImageSets(css: string, scale: number): string {
  let out = "";
  let at = 0;
  const opener = /(?:-webkit-)?image-set\(/gi;
  for (let match = opener.exec(css); match; match = opener.exec(css)) {
    // Find the matching closing parenthesis.
    let depth = 1;
    let end = opener.lastIndex;
    let quote = "";
    while (end < css.length && depth > 0) {
      const char = css[end]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
      end++;
    }
    if (depth !== 0) break;
    const entries = splitTopLevel(css.slice(opener.lastIndex, end - 1)).map((entry) => {
      const found = /^([\s\S]*?)\s*(?:type\([^)]*\)\s*)?(?:\s([0-9.]+)(x|dppx)|\s([0-9.]+)dpi)?\s*$/i.exec(entry.trim());
      if (!found || !found[1]) return null;
      const image = /^["']/.test(found[1]) ? `url(${found[1]})` : found[1];
      return { image, density: found[2] ? Number(found[2]) : found[4] ? Number(found[4]) / 96 : 1 };
    });
    out += css.slice(at, match.index);
    if (entries.length > 0 && entries.every(Boolean)) {
      const sorted = (entries as { image: string; density: number }[]).sort((a, b) => a.density - b.density);
      out += (sorted.find((entry) => entry.density >= scale) ?? sorted[sorted.length - 1]!).image;
    } else {
      out += css.slice(match.index, end);
    }
    at = end;
    opener.lastIndex = end;
  }
  return out + css.slice(at);
}

/**
 * Fixes what the viewer's own settings would otherwise change. Top-level conditions are
 * already decided inside the page; this covers the ones nested inside other rules, the
 * colour scheme an element asks for, and images chosen by screen density.
 */
function pinEnvironment(css: string, scheme: "light" | "dark", scale: number): string {
  const other = scheme === "light" ? "dark" : "light";
  const pinned = css
    .replace(new RegExp(`\\(\\s*prefers-color-scheme\\s*:\\s*${scheme}\\s*\\)`, "gi"), "(min-width: 0px)")
    .replace(new RegExp(`\\(\\s*prefers-color-scheme\\s*:\\s*${other}\\s*\\)`, "gi"), "(max-width: 0px)")
    .replace(/\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/gi, "(min-width: 0px)")
    .replace(/\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/gi, "(max-width: 0px)")
    // "light dark" follows the viewer; the capture saw one of them.
    .replace(/(^|[;{\s])color-scheme\s*:\s*([^;}!]*)/gi, (_whole, lead: string, value: string) => {
      const words = value.toLowerCase().split(/\s+/).filter(Boolean);
      const uses = words.includes(scheme) || words.includes("normal") || !words.includes(other) ? scheme : other;
      return `${lead}color-scheme:only ${uses}`;
    });
  return pinImageSets(pinned, scale);
}

function intern(list: string[], value: string): number {
  const found = list.indexOf(value);
  if (found >= 0) return found;
  list.push(value);
  return list.length - 1;
}

async function embedResource(url: string, tables: SharedTables, problems: string[]): Promise<number> {
  const cached = tables.fetched.get(url);
  if (cached !== undefined) return cached;
  let index = 0;
  const name = (() => {
    try {
      return new URL(url).pathname.split("/").pop() || "resource";
    } catch {
      return "resource";
    }
  })();
  try {
    const file = tables.loaded.get(url.split("#")[0]!);
    if (!file) throw new Error("the browser had not loaded it");
    const body = await file.body;
    if (!body) throw new Error("too large or unreadable");
    if (tables.bytes + body.length > MAX_TOTAL) throw new Error("the demo would be too large");
    let type = file.type;
    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    if (FONT_TYPES[extension]) type = FONT_TYPES[extension]!;
    if (!IMAGE_TYPES.test(type) && !Object.values(FONT_TYPES).includes(type)) throw new Error(`unsupported type ${type || "unknown"}`);
    tables.bytes += body.length;
    index = intern(tables.resources, `data:${type};base64,${body.toString("base64")}`);
  } catch (error) {
    problems.push(`a file that could not be included (${name.slice(0, 60)}: ${error instanceof Error ? error.message.split("\n")[0] : "failed"})`);
  }
  tables.fetched.set(url, index);
  return index;
}

/** Replaces placeholder numbers using a lookup. An unknown number becomes the empty resource. */
function remap(text: string, name: string, lookup: (index: number) => number): string {
  return text.replace(new RegExp(`${name}:(\\d+):`, "g"), (_match, digits) => `${name}:${lookup(Number(digits))}:`);
}

export interface SnapshotInput {
  page: Page;
  context: BrowserContext;
  target?: ElementHandle<Element> | null;
  maskSelectors: string[];
  maskColor: string;
  scheme: "light" | "dark";
  /** Pixel density of the capture, used to pick images that depend on it. */
  scale?: number;
  /** Text to swap in the copy, including inside attributes the screen does not show. */
  replace?: Record<string, string>;
  tables: SharedTables;
}

/** Copies the page's structure. Returns problems that mean the copy should not be trusted without a check. */
export async function takeSnapshot(input: SnapshotInput): Promise<{ snapshot?: Snapshot; problems: string[] }> {
  const { page, tables } = input;
  let raw: RawSnapshot;
  try {
    raw = await page.evaluate(serializeInPage, {
      target: input.target ?? null,
      maskSelectors: input.maskSelectors,
      alwaysMasked: ALWAYS_MASKED,
      maskColor: input.maskColor,
      resToken: RES_TOKEN,
      styleToken: STYLE_TOKEN,
    });
  } catch (error) {
    return { problems: [`the page could not be copied (${error instanceof Error ? error.message.split("\n")[0] : "error"})`] };
  }
  // Everything below treats the page's answer as untrusted text.
  if (!raw || typeof raw.html !== "string" || !Array.isArray(raw.styles) || !Array.isArray(raw.resources)) {
    return { problems: ["the page returned an unusable copy"] };
  }
  if (raw.html.length > MAX_HTML) return { problems: ["a page too large to copy"] };
  const problems = (Array.isArray(raw.problems) ? raw.problems : []).filter((p): p is string => typeof p === "string").map((p) => p.slice(0, 200));

  const local = raw.resources.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 400);
  const register = (url: string) => {
    let index = local.indexOf(url);
    if (index < 0) index = local.push(url) - 1;
    return `${RES_TOKEN}:${index}:`;
  };

  // Stylesheets the page could not read itself (other origins) are fetched here.
  const cssTexts: string[] = [];
  for (const style of raw.styles.slice(0, 200)) {
    let css = typeof style?.css === "string" ? style.css : "";
    if (!css && typeof style?.href === "string" && /^https?:\/\//.test(style.href)) {
      const file = tables.loaded.get(style.href.split("#")[0]!);
      const body = file ? await file.body : null;
      if (body) css = rewriteUrls(body.toString("utf8"), style.href, register);
      else problems.push("a stylesheet that could not be read");
    }
    const media = typeof style?.media === "string" ? style.media.replace(/[{}<>]/g, "") : "";
    cssTexts.push(media && media !== "all" ? `@media ${media}{${css}}` : css);
  }

  const resourceMap: number[] = [];
  for (const url of local) resourceMap.push(await embedResource(url, tables, problems));
  const toShared = (index: number) => resourceMap[index] ?? 0;

  const styleMap = cssTexts.map((css) => intern(tables.styles, sanitizeCss(pinEnvironment(remap(css, RES_TOKEN, toShared), input.scheme, input.scale ?? 1))));
  // Freeze motion, the colour scheme and scrollbars so the copy looks the same for every viewer:
  // a viewer in dark mode, with forced colours, or with always-visible scrollbars sees the capture.
  const freeze = intern(
    tables.styles,
    `:root{color-scheme:only ${input.scheme}!important}` +
      "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;" +
      "transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important;" +
      "forced-color-adjust:none!important;scrollbar-width:none!important}" +
      "::-webkit-scrollbar{display:none!important}",
  );

  let html = remap(raw.html, RES_TOKEN, toShared);
  html = remap(html, STYLE_TOKEN, (index) => styleMap[index] ?? freeze);
  html = sanitizeHtml(html);
  html = replaceInMarkup(html, input.replace ?? {});
  html = html.replace("</head>", `<style>${STYLE_TOKEN}:${freeze}:</style></head>`);
  const scroll: [number, number] = [Number(raw.scroll?.[0]) || 0, Number(raw.scroll?.[1]) || 0];
  return { snapshot: { html, scroll }, problems };
}

const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Applies the "replace" rules to a cleaned copy. The screen only shows text, but a copy also
 * carries attributes (alt, title, labels, data values) where the real text would otherwise ship.
 */
export function replaceInMarkup(html: string, rules: Record<string, string>): string {
  let out = html;
  for (const [from, to] of Object.entries(rules)) {
    for (const escape of [escapeText, escapeAttribute]) {
      const needle = escape(from);
      if (needle) out = out.split(needle).join(escape(to));
    }
  }
  return out;
}

/** Fills placeholders with the real styles and resources. The player does the same when it shows a step. */
export function expandTokens(html: string, tables: Pick<SharedTables, "styles" | "resources">): string {
  const withStyles = html.replace(new RegExp(`${STYLE_TOKEN}:(\\d+):`, "g"), (_m, d) => tables.styles[Number(d)] ?? "");
  return withStyles.replace(new RegExp(`${RES_TOKEN}:(\\d+):`, "g"), (_m, d) => tables.resources[Number(d)] ?? "data:,");
}

export const FRAME_POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export interface FidelityInput {
  context: BrowserContext;
  snapshot: Snapshot;
  tables: SharedTables;
  screenshot: Buffer;
  viewport: { width: number; height: number };
}

export interface Fidelity {
  /** Pixels that differ. */
  pixels: number;
  /** Share of all pixels that differ, 0 to 1. */
  overall: number;
  /** Differing pixels in the worst small region. Catches a changed character or icon that is tiny overall. */
  worstRegion: number;
}

const REGION = 24;
/** Colour channels may be off by this much before a pixel counts as different (rendering noise). */
const NOISE = 3;
/** This many differing pixels close together mean something visible is different there. */
export const REGION_LIMIT = 3;

/** Compares two same-size images pixel by pixel. */
export function compareImages(a: PNG, b: PNG): Fidelity {
  if (a.width !== b.width || a.height !== b.height) return { pixels: a.width * a.height, overall: 1, worstRegion: REGION * REGION };
  const columns = Math.ceil(a.width / REGION);
  const counts = new Uint32Array(columns * Math.ceil(a.height / REGION));
  let total = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) << 2;
      if (
        Math.abs(a.data[i]! - b.data[i]!) > NOISE ||
        Math.abs(a.data[i + 1]! - b.data[i + 1]!) > NOISE ||
        Math.abs(a.data[i + 2]! - b.data[i + 2]!) > NOISE
      ) {
        total++;
        counts[Math.floor(y / REGION) * columns + Math.floor(x / REGION)]!++;
      }
    }
  }
  let worst = 0;
  for (const count of counts) if (count > worst) worst = count;
  return { pixels: total, overall: total / (a.width * a.height), worstRegion: worst };
}

/** True when a copy is close enough to the real screen to be shown in its place. */
export function isFaithful(fidelity: Fidelity, tolerance: number): boolean {
  return fidelity.overall <= tolerance && fidelity.worstRegion < REGION_LIMIT;
}

/** True when two captures of a screen show the same thing. Used to tell whether a demo is out of date. */
export function isSameScreen(fidelity: Fidelity): boolean {
  return fidelity.pixels <= 2;
}

/**
 * Shows the copy exactly as the player will (same sandbox, no network) and compares
 * it with the real screenshot.
 */
export async function measureFidelity(input: FidelityInput): Promise<Fidelity> {
  const { context, snapshot, tables, screenshot, viewport } = input;
  const page = await context.newPage();
  try {
    // The finished demo cannot reach the network, so the check must not either.
    await page.route("**/*", (route) => (/^(data|about|blob):/.test(route.request().url()) ? route.continue() : route.abort()));
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}; script-src 'none'">` +
        `<style>html,body{margin:0;overflow:hidden}iframe{border:0;display:block;width:${viewport.width}px;height:${viewport.height}px}</style>` +
        `<iframe sandbox="allow-same-origin"></iframe>`,
    );
    await page.evaluate(
      async ({ html, scroll }) => {
        const frame = document.querySelector("iframe")!;
        await new Promise<void>((done) => {
          frame.addEventListener("load", () => done(), { once: true });
          frame.srcdoc = html;
        });
        await frame.contentDocument!.fonts.ready;
        const inner = frame.contentDocument!;
        for (const node of Array.from(inner.querySelectorAll("[data-dk-st],[data-dk-sl]"))) {
          node.scrollTop = Number(node.getAttribute("data-dk-st")) || 0;
          node.scrollLeft = Number(node.getAttribute("data-dk-sl")) || 0;
        }
        frame.contentWindow!.scrollTo(scroll[0], scroll[1]);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      },
      { html: expandTokens(snapshot.html, tables), scroll: snapshot.scroll },
    );
    const rendered = PNG.sync.read(await page.screenshot({ type: "png", animations: "disabled", caret: "hide", scale: "device", clip: { x: 0, y: 0, ...viewport } }));
    const real = PNG.sync.read(screenshot);
    return compareImages(rendered, real);
  } catch {
    return { pixels: Number.MAX_SAFE_INTEGER, overall: 1, worstRegion: REGION * REGION };
  } finally {
    await page.close();
  }
}

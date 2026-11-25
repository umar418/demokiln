import { parse, serialize } from "parse5";

/** Placeholders the capture step leaves in a snapshot. They are filled in from shared tables when the demo is shown. */
export const RES_TOKEN = "dk-res-7f3a";
export const STYLE_TOKEN = "dk-style-7f3a";

const RES_ONLY = new RegExp(`^${RES_TOKEN}:\\d+:$`);
const STYLE_ONLY = new RegExp(`^${STYLE_TOKEN}:\\d+:$`);

/** Elements that can run code, load something, or change how the document is addressed. */
const DROPPED = new Set([
  "script", "noscript", "base", "link", "meta", "iframe", "frame", "frameset", "object", "embed",
  "applet", "template", "portal", "fencedframe", "audio", "video", "source", "track",
]);

/** Attributes that load a resource. Only a placeholder or an inline image may remain. */
const LOADING = new Set(["src", "srcset", "poster", "background", "data", "lowsrc", "dynsrc", "imagesrcset"]);

/** Attributes that are never needed in a still capture. */
const REMOVED = new Set([
  "srcdoc", "nonce", "integrity", "ping", "action", "formaction", "manifest", "codebase", "autofocus", "http-equiv",
]);

function looksExecutable(value: string): boolean {
  // Browsers ignore whitespace and control characters inside a scheme.
  let compact = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code > 32 && !(code >= 127 && code <= 159)) compact += char.toLowerCase();
  }
  return /^(javascript|vbscript|livescript|mocha):/.test(compact) || /^data:(?!image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)[;,])/.test(compact);
}

/**
 * Makes CSS safe to embed: nothing may be imported or loaded except placeholders
 * and inline images or fonts, and the text cannot close its own style element.
 */
export function sanitizeCss(css: string): string {
  let out = css.replace(/<\/(style)/gi, "<\\/$1").replace(/<!--|-->/g, "");
  out = out.replace(/@import\b[^;{}]*;?/gi, "");
  out = out.replace(/expression\s*\(/gi, "invalid(").replace(/-moz-binding\s*:/gi, "invalid:").replace(/behavior\s*:/gi, "invalid:");
  out = out.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_match, a, b, c) => {
    const target = String(a ?? b ?? c ?? "").trim();
    if (RES_ONLY.test(target)) return `url("${target}")`;
    if (/^#[\w-]+$/.test(target)) return `url("${target}")`;
    if (/^data:(image\/(png|jpeg|gif|webp|avif|svg\+xml)|font\/[\w+.-]+|application\/(font-[\w+.-]+|x-font-[\w+.-]+|vnd\.ms-fontobject|octet-stream))[;,]/i.test(target) && !/["'()\\\s<>]/.test(target)) {
      return `url("${target}")`;
    }
    return 'url("data:,")';
  });
  // image-set() and bare strings in src descriptors can also name a resource.
  out = out.replace(/(image-set\()([^)]*)\)/gi, (_m, head, body) => `${head}${String(body).replace(/(["'])(?!data:|dk-res)[^"']*\1/g, '"data:,"')})`);
  return out;
}

interface Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  value?: string;
  content?: Node;
}

function clean(node: Node): void {
  if (!node.childNodes) return;
  const kept: Node[] = [];
  for (const child of node.childNodes) {
    const tag = child.tagName?.toLowerCase();
    if (child.nodeName === "#comment") continue;
    if (tag) {
      if (tag === "meta") {
        const charset = child.attrs?.find((a) => a.name.toLowerCase() === "charset");
        if (!charset || child.attrs!.length !== 1) continue;
      } else if (DROPPED.has(tag)) {
        continue;
      }
      if (tag === "style") {
        const text = (child.childNodes ?? []).map((n) => n.value ?? "").join("").trim();
        // A style element may only hold a placeholder. Real CSS lives in the shared, cleaned table.
        if (!STYLE_ONLY.test(text)) continue;
        child.attrs = [];
        kept.push(child);
        continue;
      }
      child.attrs = (child.attrs ?? []).filter((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || REMOVED.has(name)) return false;
        if (looksExecutable(attr.value)) return false;
        if (LOADING.has(name)) return RES_ONLY.test(attr.value.trim()) || /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(attr.value.trim());
        if (name === "style") attr.value = sanitizeCss(attr.value);
        // SVG can load or run through these.
        if ((name === "href" || name === "xlink:href") && tag !== "a" && tag !== "area") {
          return /^#/.test(attr.value.trim()) || RES_ONLY.test(attr.value.trim());
        }
        return true;
      });
      if (tag === "a" || tag === "area") {
        // Links stay for their styling but must go nowhere if something ever activates them.
        for (const attr of child.attrs) if (attr.name.toLowerCase() === "href") attr.value = "#";
        child.attrs = child.attrs.filter((a) => !["target", "download"].includes(a.name.toLowerCase()));
      }
    }
    clean(child);
    kept.push(child);
  }
  node.childNodes = kept;
}

/**
 * Cleans a captured page so it can only be looked at. The capture runs inside the
 * page being captured, which may be hostile, so nothing it returns is trusted:
 * the markup is parsed again here and everything that could run or load is removed.
 */
export function sanitizeHtml(html: string): string {
  const document = parse(html) as unknown as Node;
  clean(document);
  return serialize(document as never);
}

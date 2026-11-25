import type { Locator, Page } from "playwright";
import { SECRET_PATTERNS } from "../privacy/secrets.js";

/**
 * An element on the page: a Playwright locator, a CSS selector string, or { text } to find it
 * by what a person sees (a button or link name, a field label, a placeholder, or exact text).
 */
export type Target = Locator | string | { text: string };

export interface Viewport {
  width: number;
  height: number;
}

export const VIEWPORTS: Record<string, Viewport> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 834, height: 1112 },
  phone: { width: 390, height: 844 },
};

export interface DemoOptions {
  /** Where the demo starts. http, https or file URL. */
  url: string;
  /** Shown in the player's title bar and as the page title. */
  title?: string;
  viewport?: "desktop" | "tablet" | "phone" | Viewport;
  /** Pixel density of captures. 2 is sharp on high-density screens; 1 halves file size. */
  scale?: number;
  colorScheme?: "light" | "dark";
  /** CSS selectors to cover in every capture. Their text is also left out of the credential scan. */
  mask?: string[];
  /** Text to swap before capture: { "Real Customer Ltd": "Acme Inc" }. */
  replace?: Record<string, string>;
  /** Path to a saved Playwright session (storage state) for apps behind sign-in. */
  storageState?: string;
  /** Milliseconds to wait for one step's element or action. */
  stepTimeout?: number;
  /** Milliseconds to wait for the screen to stop changing before a capture. */
  settleTimeout?: number;
  /** Caption on the closing screen. */
  endCaption?: string;
  /** Button on the closing screen. http or https only. */
  cta?: { label: string; url: string };
  /** Advance by itself, waiting this many milliseconds on each screen. The viewer can still take over. */
  autoplay?: number;
  /** Accent colour as a hex value, e.g. "#4f46e5". */
  accent?: string;
  /**
   * "auto" (default) keeps the real page structure when it matches the screenshot, which stays
   * sharp at any size, and uses the screenshot otherwise. "screenshot" always uses screenshots.
   */
  capture?: "auto" | "screenshot";
  /** Share of pixels a structure capture may differ from the screenshot before it is discarded. Default 0.002. */
  fidelity?: number;
  /**
   * The date and time the app's clock starts at for the capture, e.g. "2026-01-15T09:30:00Z".
   * Defaults to the moment the build starts. The clock then runs normally, so a page that shows
   * the date, or the time to the minute, gives the same demo each build; seconds will differ.
   */
  time?: string;
  /** Credential pattern ids to ignore when they are known false positives. */
  allowSecrets?: string[];
}

export interface StepApi {
  /** Capture the screen with a hotspot on the target, then click it. */
  click(target: Target, caption: string): Promise<void>;
  /** Capture the screen with a hotspot on the field, then type the value. The value is never stored. */
  fill(target: Target, value: string, caption: string): Promise<void>;
  /** Capture the screen with a hotspot on the target, then double-click it. */
  dblclick(target: Target, caption: string): Promise<void>;
  /** Capture the screen with a hotspot on the list, then choose an option by its label or value. */
  select(target: Target, option: string, caption: string): Promise<void>;
  /** Capture the screen with a hotspot on the target, then press a key there, such as "Enter". */
  press(target: Target, key: string, caption: string): Promise<void>;
  /** Capture the screen with a hotspot on the target, then hover it. */
  hover(target: Target, caption: string): Promise<void>;
  /** Capture the screen with a caption only, optionally pointing at an element. Nothing is clicked. */
  note(caption: string, options?: { at?: Target }): Promise<void>;
  /** Run setup that must not appear in the demo, such as signing in. */
  hidden(run: () => Promise<void>): Promise<void>;
  /** Start a named chapter. Following steps belong to it. */
  chapter(title: string): void;
}

export interface DemoContext {
  page: Page;
  step: StepApi;
}

export interface DemoDefinition {
  __demokiln: 1;
  options: DemoOptions;
  run: (context: DemoContext) => Promise<void>;
}

export class DemoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoConfigError";
  }
}

function fail(message: string): never {
  throw new DemoConfigError(message);
}

export function resolveViewport(viewport: DemoOptions["viewport"]): Viewport {
  if (viewport === undefined) return VIEWPORTS.desktop!;
  if (typeof viewport === "string") {
    const found = VIEWPORTS[viewport];
    if (!found) fail(`Unknown viewport "${viewport}". Use desktop, tablet, phone or { width, height }.`);
    return found;
  }
  const { width, height } = viewport;
  const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 200 && n <= 4000;
  if (!ok(width) || !ok(height)) fail("viewport width and height must be whole numbers between 200 and 4000.");
  return { width, height };
}

export const CAPTION_LIMIT = 280;

const OPTION_KEYS = [
  "url", "title", "viewport", "scale", "colorScheme", "mask", "replace", "storageState", "stepTimeout", "settleTimeout",
  "endCaption", "cta", "accent", "autoplay", "capture", "fidelity", "time", "allowSecrets",
];

/** Checks options once, up front, so a bad setting fails before a browser is opened. */
export function validateOptions(options: DemoOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("demo() needs an options object with at least a url.");
  for (const key of Object.keys(options)) if (!OPTION_KEYS.includes(key)) fail(`Unknown setting "${key}".`);
  if (typeof options.url !== "string" || !/^(https?|file):\/\//i.test(options.url)) {
    fail("url must start with http://, https:// or file://.");
  }
  const text = (key: "title" | "endCaption" | "storageState") => {
    const value = options[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) fail(`${key} must be text. If it looks like a number or a date, put it in quotes.`);
  };
  text("title");
  text("endCaption");
  text("storageState");
  if (options.endCaption !== undefined && options.endCaption.length > CAPTION_LIMIT) fail(`endCaption must be at most ${CAPTION_LIMIT} characters.`);
  if (options.viewport !== undefined && typeof options.viewport === "object") {
    if (options.viewport === null || Array.isArray(options.viewport)) fail("viewport must be desktop, tablet, phone or { width, height }.");
    for (const key of Object.keys(options.viewport)) if (key !== "width" && key !== "height") fail(`viewport has an unknown setting "${key}".`);
  }
  resolveViewport(options.viewport);
  const number = (key: "scale" | "autoplay" | "fidelity" | "stepTimeout" | "settleTimeout", low: number, high: number, unit: string) => {
    const value = options[key];
    if (value !== undefined && !(typeof value === "number" && value >= low && value <= high)) fail(`${key} must be a number between ${low} and ${high}${unit}.`);
  };
  number("scale", 1, 3, "");
  number("autoplay", 800, 60_000, " milliseconds");
  number("fidelity", 0, 0.05, "");
  number("stepTimeout", 100, 600_000, " milliseconds");
  number("settleTimeout", 100, 600_000, " milliseconds");
  if (options.colorScheme !== undefined && options.colorScheme !== "light" && options.colorScheme !== "dark") fail('colorScheme must be "light" or "dark".');
  if (options.capture !== undefined && options.capture !== "auto" && options.capture !== "screenshot") fail('capture must be "auto" or "screenshot".');
  if (options.accent !== undefined && (typeof options.accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(options.accent))) {
    fail('accent must be a six-digit hex colour such as "#4f46e5".');
  }
  if (options.time !== undefined && (typeof options.time !== "string" || Number.isNaN(Date.parse(options.time)))) {
    fail('time must be a date and time such as "2026-01-15T09:30:00Z".');
  }
  if (options.cta !== undefined) {
    if (!options.cta || typeof options.cta !== "object" || Array.isArray(options.cta)) fail("cta must have a label and a url.");
    for (const key of Object.keys(options.cta)) if (key !== "label" && key !== "url") fail(`cta has an unknown setting "${key}".`);
    if (typeof options.cta.label !== "string" || !options.cta.label.trim()) fail("cta.label must not be empty.");
    if (typeof options.cta.url !== "string" || !/^https?:\/\//i.test(options.cta.url)) {
      fail("cta.url must start with http:// or https://.");
    }
  }
  if (options.replace !== undefined && (!options.replace || typeof options.replace !== "object" || Array.isArray(options.replace))) {
    fail('replace must be pairs of text, such as { "Real name": "Sample name" }.');
  }
  for (const [from, to] of Object.entries(options.replace ?? {})) {
    if (!from) fail("replace keys must not be empty.");
    if (typeof to !== "string") fail(`replace value for "${from}" must be text.`);
  }
  if (options.mask !== undefined && !Array.isArray(options.mask)) fail('mask must be a list of CSS selectors, such as [".email"].');
  for (const selector of options.mask ?? []) {
    if (typeof selector !== "string" || !selector.trim()) fail("mask entries must be CSS selectors.");
  }
  if (options.allowSecrets !== undefined && !Array.isArray(options.allowSecrets)) fail('allowSecrets must be a list of pattern ids, such as ["jwt"].');
  for (const id of options.allowSecrets ?? []) {
    if (!SECRET_PATTERNS.some((pattern) => pattern.id === id)) {
      fail(`allowSecrets has an unknown id "${String(id)}". Known ids: ${SECRET_PATTERNS.map((pattern) => pattern.id).join(", ")}.`);
    }
  }
}

/** Define a demo. The script file's default export. */
export function demo(options: DemoOptions, run: (context: DemoContext) => Promise<void>): DemoDefinition {
  validateOptions(options);
  if (typeof run !== "function") fail("demo() needs a function that performs the steps.");
  return { __demokiln: 1, options, run };
}

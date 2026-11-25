import { chromium, type Browser, type Locator, type Page } from "playwright";
import { CAPTION_LIMIT, resolveViewport, type DemoDefinition, type StepApi, type Target, type Viewport } from "../script/api.js";
import { scanForSecrets, SecretFoundError } from "../privacy/secrets.js";
import { ALWAYS_MASKED, applyReplacements, collectText, coveredBy, markCardFields, settle, watchActivity } from "./page.js";
import { isFaithful, measureFidelity, newTables, takeSnapshot, watchResponses, type SharedTables, type Snapshot } from "./snapshot.js";

export type StepKind = "click" | "dblclick" | "fill" | "select" | "press" | "hover" | "note" | "end";

/** A rectangle as fractions of the capture's width and height, so it scales with the image. */
export interface Hotspot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CapturedStep {
  kind: StepKind;
  caption: string;
  chapter?: string;
  image: Buffer;
  hotspot?: Hotspot;
  /** The page's real structure, kept only when it was shown to match the screenshot. */
  structure?: Snapshot;
  /** Why a step uses a screenshot instead of the page structure. Informational. */
  notes: string[];
  warnings: string[];
}

export interface RunResult {
  title: string;
  viewport: Viewport;
  steps: CapturedStep[];
  /** Styles and resources shared by the structure captures. */
  tables: Pick<SharedTables, "styles" | "resources">;
  accent?: string;
  cta?: { label: string; url: string };
  autoplay?: number;
  /** The date and time the app saw during capture, as an ISO string. */
  time: string;
  /** Pixel density of the captures. */
  scale: number;
}

export interface RunOptions {
  headless?: boolean;
  /** Use this date and time instead of the script's or the current one. "check" passes the last build's. */
  time?: string;
  /** Called after each captured step, for progress output. */
  onStep?: (number: number, step: CapturedStep) => void;
}

export class DemoStepError extends Error {
  constructor(
    readonly stepNumber: number,
    readonly caption: string,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    super(caption ? `Step ${stepNumber} (“${caption}”) failed: ${reason}` : `${reason}`);
    this.name = "DemoStepError";
    this.cause = cause;
  }
}

const MASK_COLOR = "#c9ced8";

export async function runDemo(definition: DemoDefinition, runOptions: RunOptions = {}): Promise<RunResult> {
  const options = definition.options;
  const viewport = resolveViewport(options.viewport);
  const stepTimeout = options.stepTimeout ?? 10_000;
  const settleTimeout = options.settleTimeout ?? 8_000;
  const maskSelectors = options.mask ?? [];
  const steps: CapturedStep[] = [];
  const tables = newTables();
  const scheme = options.colorScheme ?? "light";
  const scale = options.scale ?? 2;
  const tolerance = options.fidelity ?? 0.002;
  const time = new Date(runOptions.time ?? options.time ?? Date.now()).toISOString();
  let hiddenDepth = 0;
  let chapter: string | undefined;

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: runOptions.headless ?? true });
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: scale,
      colorScheme: scheme,
      reducedMotion: "reduce",
      storageState: options.storageState,
    });
    context.setDefaultTimeout(stepTimeout);
    // The app sees one fixed date and time, so a screen that prints "today" is the same in every build.
    await context.clock.setFixedTime(new Date(time));
    watchResponses(context, tables);
    const activity = await watchActivity(context);
    const page = await context.newPage();

    const locate = async (target: Target, kind: StepKind): Promise<Locator> => {
      if (typeof target === "string") return page.locator(target);
      if (typeof (target as { text?: unknown }).text === "string") return findByText(page, (target as { text: string }).text, kind, stepTimeout);
      return target as Locator;
    };

    const capture = async (kind: StepKind, caption: string, target: Locator | undefined): Promise<void> => {
      const warnings: string[] = [];
      if (target) {
        await target.waitFor({ state: "visible", timeout: stepTimeout });
        await target.scrollIntoViewIfNeeded({ timeout: stepTimeout });
      }
      await applyReplacements(page, options.replace ?? {});
      if (!(await settle(page, settleTimeout, activity))) {
        warnings.push("The screen was still changing when it was captured. Add a mask over the moving part, or raise settleTimeout if the app was still loading.");
      }
      // Replacements can be undone by a re-render while settling, so apply them again right before capture.
      await applyReplacements(page, options.replace ?? {});
      await markCardFields(page);

      let hotspot: Hotspot | undefined;
      if (target) {
        // A hotspot on an element hidden under a banner or a fixed header would point at the wrong thing.
        let cover = await coveredBy(target);
        if (cover) {
          await target.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }));
          await settle(page, Math.min(settleTimeout, 2000), activity);
          cover = await coveredBy(target);
        }
        if (cover) {
          throw new Error(`the element is covered by ${cover}. Close or hide what covers it in a hidden step first, so the demo can point at it.`);
        }
        const box = await target.boundingBox();
        if (!box) throw new Error("the element is not visible on screen.");
        hotspot = toHotspot(box, viewport);
        if (!hotspot) throw new Error("the element is outside the visible area even after scrolling.");
      }

      const number = steps.length + 1;
      const shown = await collectText(page, maskSelectors);
      const hits = scanForSecrets(`${caption}\n${shown}`, options.allowSecrets);
      if (hits.length > 0) throw new SecretFoundError(number, caption, hits);
      for (const from of Object.keys(options.replace ?? {})) {
        if (shown.includes(from)) {
          throw new Error(`“${from}” is still on screen after "replace", because it is split across elements or drawn by a style. Cover it with "mask" instead.`);
        }
      }

      const image = await page.screenshot({
        type: "png",
        animations: "disabled",
        caret: "hide",
        scale: "device",
        mask: [...maskSelectors, ALWAYS_MASKED].map((selector) => page.locator(selector)),
        maskColor: MASK_COLOR,
      });
      const step: CapturedStep = { kind, caption, image, notes: [], warnings };
      if (hotspot) step.hotspot = hotspot;
      if ((options.capture ?? "auto") === "auto") {
        const handle = target ? await target.elementHandle({ timeout: stepTimeout }) : null;
        const { snapshot, problems } = await takeSnapshot({
          page, context, target: handle, maskSelectors, maskColor: MASK_COLOR, scheme, scale, replace: options.replace, tables,
        });
        await handle?.dispose();
        if (!snapshot) {
          step.notes.push(`Screenshot used: ${problems[0] ?? "the page could not be copied"}.`);
        } else if (scanForSecrets(`${snapshot.html}\n${tables.styles.join("\n")}`, options.allowSecrets).length > 0) {
          // Not on screen, so the screenshot is safe, but the page source must not be shipped.
          step.notes.push("Screenshot used: the page source holds a likely credential that is not visible on screen.");
        } else {
          const fidelity = await measureFidelity({ context, snapshot, tables, screenshot: image, viewport });
          if (isFaithful(fidelity, tolerance)) step.structure = snapshot;
          else {
            const cause = problems.length > 0 ? ` The page has ${[...new Set(problems)].slice(0, 3).join(", ")}.` : "";
            const size = fidelity.overall >= 0.0001 ? `${(fidelity.overall * 100).toFixed(2)}% of the screen` : `${fidelity.pixels} pixels close together`;
            step.notes.push(`Screenshot used: a copy of the page did not match the real screen exactly (${size} differed).${cause}`);
          }
        }
      }
      if (chapter) step.chapter = chapter;
      steps.push(step);
      runOptions.onStep?.(number, step);
    };

    /** Captures the screen (unless hidden), then performs the action. Errors name the step. */
    const perform = async (
      kind: StepKind,
      caption: string,
      target: Target | undefined,
      action: (locator: Locator | undefined) => Promise<unknown>,
    ): Promise<void> => {
      const number = steps.length + 1;
      try {
        if (hiddenDepth === 0) {
          if (typeof caption !== "string" || !caption.trim()) throw new Error(`step.${kind} needs a caption, the text shown to the viewer.`);
          if (caption.length > CAPTION_LIMIT) throw new Error(`the caption is ${caption.length} characters long; the limit is ${CAPTION_LIMIT} so it fits beside what it points at.`);
        }
        const locator = target === undefined ? undefined : await locate(target, kind);
        if (hiddenDepth === 0) await capture(kind, caption, locator);
        await action(locator);
        // The pointer is moved off the page, so the next screen is not captured with the
        // element just clicked still highlighted. A hover step keeps the pointer where it is.
        if (kind !== "hover" && kind !== "note") await page.mouse.move(-1, -1).catch(() => {});
      } catch (error) {
        if (error instanceof SecretFoundError || error instanceof DemoStepError) throw error;
        if (hiddenDepth > 0) {
          const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
          throw new DemoStepError(number, "", new Error(`A hidden ${kind} step before screen ${number} failed: ${reason}`));
        }
        throw new DemoStepError(number, caption, error);
      }
    };

    const step: StepApi = {
      click: (target, caption) => perform("click", caption, target, (locator) => locator!.click({ timeout: stepTimeout })),
      dblclick: (target, caption) => perform("dblclick", caption, target, (locator) => locator!.dblclick({ timeout: stepTimeout })),
      fill: (target, value, caption) => perform("fill", caption, target, (locator) => locator!.fill(String(value), { timeout: stepTimeout })),
      select: (target, option, caption) =>
        perform("select", caption, target, async (locator) => {
          // By the text the person sees first, then by the underlying value.
          const byLabel = await locator!.selectOption({ label: String(option) }, { timeout: 1500 }).catch(() => null);
          if (!byLabel) await locator!.selectOption({ value: String(option) }, { timeout: stepTimeout });
        }),
      press: (target, key, caption) => perform("press", caption, target, (locator) => locator!.press(String(key), { timeout: stepTimeout })),
      hover: (target, caption) => perform("hover", caption, target, (locator) => locator!.hover({ timeout: stepTimeout })),
      note: (caption, noteOptions) => perform("note", caption, noteOptions?.at, async () => {}),
      hidden: async (run) => {
        hiddenDepth++;
        try {
          await run();
        } finally {
          hiddenDepth--;
        }
      },
      chapter: (title) => {
        chapter = String(title);
      },
    };

    await page.goto(options.url, { timeout: Math.max(stepTimeout, 30_000) });
    try {
      await definition.run({ page, step });
    } catch (error) {
      if (error instanceof SecretFoundError || error instanceof DemoStepError) throw error;
      // An error in the script's own code between steps: say where the demo had got to.
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      const where = steps.length === 0 ? "before the first screen" : `after screen ${steps.length} (“${steps[steps.length - 1]!.caption}”)`;
      throw new DemoStepError(steps.length + 1, "", new Error(`The script failed ${where}: ${reason}`));
    }

    if (steps.length === 0) {
      throw new Error("The script captured no steps. Call step.click, step.fill, step.hover or step.note at least once.");
    }
    // The closing screen shows the result of the last action.
    try {
      await capture("end", options.endCaption ?? "That’s the tour.", undefined);
    } catch (error) {
      if (error instanceof SecretFoundError) throw error;
      throw new DemoStepError(steps.length + 1, "closing screen", error);
    }

    const result: RunResult = {
      title: options.title ?? "Product demo", viewport, steps, time, scale,
      tables: { styles: tables.styles, resources: tables.resources },
    };
    if (options.accent) result.accent = options.accent;
    if (options.cta) result.cta = options.cta;
    if (options.autoplay) result.autoplay = options.autoplay;
    return result;
  } finally {
    await browser?.close();
  }
}

/**
 * Finds one element by what a person sees: a button, link, tab or menu item with that name,
 * a field with that label or placeholder, or that exact text. Only visible elements count.
 * If more than one distinct element matches, the step fails rather than guessing.
 */
export async function findByText(page: Page, text: string, kind: StepKind, timeout: number): Promise<Locator> {
  const fields: [string, Locator][] = [
    ["a field labelled", page.getByLabel(text, { exact: true })],
    ["a field with the placeholder", page.getByPlaceholder(text, { exact: true })],
    ["a text box named", page.getByRole("textbox", { name: text, exact: true })],
    ["a list named", page.getByRole("combobox", { name: text, exact: true })],
  ];
  const actions: [string, Locator][] = [
    ["a button named", page.getByRole("button", { name: text, exact: true })],
    ["a link named", page.getByRole("link", { name: text, exact: true })],
    ["a tab named", page.getByRole("tab", { name: text, exact: true })],
    ["a menu item named", page.getByRole("menuitem", { name: text, exact: true })],
    ["a checkbox named", page.getByRole("checkbox", { name: text, exact: true })],
    ["an option named", page.getByRole("radio", { name: text, exact: true })],
  ];
  const plain: [string, Locator][] = [["text reading", page.getByText(text, { exact: true })]];
  const candidates = kind === "fill" || kind === "select" ? fields : kind === "press" ? [...fields, ...actions] : [...actions, ...fields, ...plain];

  const deadline = Date.now() + timeout;
  for (;;) {
    const found: { description: string; locator: Locator }[] = [];
    for (const [description, base] of candidates) {
      const visible = base.filter({ visible: true });
      const count = Math.min(await visible.count(), 4);
      for (let i = 0; i < count; i++) found.push({ description, locator: visible.nth(i) });
    }
    if (found.length > 0) {
      // One element is often found several ways (a button is also "text"); a label and its
      // field, or an element and what it contains, count as the same thing.
      const handles = await Promise.all(found.map((entry) => entry.locator.elementHandle()));
      const keep = await page.evaluate((elements) => {
        const same = (a: Element, b: Element) =>
          a === b || a.contains(b) || b.contains(a) || (a as HTMLLabelElement).control === b || (b as HTMLLabelElement).control === a;
        const kept: number[] = [];
        elements.forEach((element, index) => {
          if (element && !kept.some((k) => same(elements[k] as Element, element as Element))) kept.push(index);
        });
        return kept;
      }, handles);
      await Promise.all(handles.map((handle) => handle?.dispose()));
      if (keep.length === 1) return found[keep[0]!]!.locator;
      if (keep.length > 1) {
        const kinds = [...new Set(keep.map((index) => found[index]!.description.replace(/ (named|labelled|reading)$/, "").replace(" with the placeholder", " placeholder")))];
        throw new Error(`${keep.length} elements match “${text}” (${kinds.join(", ")}). Use a CSS selector to pick one.`);
      }
    }
    if (Date.now() >= deadline) throw new Error(`nothing visible on the page matches “${text}”.`);
    await page.waitForTimeout(100);
  }
}

/** Converts a pixel box to fractions of the viewport, clipped to what is visible. */
export function toHotspot(box: { x: number; y: number; width: number; height: number }, viewport: Viewport): Hotspot | undefined {
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  if (right - left < 1 || bottom - top < 1) return undefined;
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  return {
    x: round(left / viewport.width),
    y: round(top / viewport.height),
    w: round((right - left) / viewport.width),
    h: round((bottom - top) / viewport.height),
  };
}

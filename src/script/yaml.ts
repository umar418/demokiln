import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { demo, DemoConfigError, type DemoDefinition, type DemoOptions, type StepApi, type Target } from "./api.js";

const OPTION_KEYS = new Set([
  "url", "title", "viewport", "scale", "colorScheme", "mask", "replace", "storageState", "stepTimeout",
  "settleTimeout", "endCaption", "cta", "accent", "allowSecrets", "capture", "fidelity", "autoplay", "time",
]);
const STEP_KEYS: Record<string, string[]> = {
  click: ["click", "caption"],
  fill: ["fill", "value", "caption"],
  dblclick: ["dblclick", "caption"],
  select: ["select", "option", "caption"],
  press: ["press", "on", "caption"],
  hover: ["hover", "caption"],
  note: ["note", "at"],
  chapter: ["chapter"],
  hidden: ["hidden"],
  wait: ["wait"],
};

function fail(message: string): never {
  throw new DemoConfigError(message);
}

/** "#id", ".class", "[attr]" or "css=..." is a selector; anything else is what a person sees on screen. */
export function toTarget(value: unknown, where: string): Target {
  if (typeof value !== "string" || !value.trim()) fail(`${where} must be text: either what is shown on screen or a CSS selector.`);
  if (value.startsWith("css=")) return value.slice(4);
  return /^[#.\[]/.test(value) ? value : { text: value };
}

/**
 * Replaces ${NAME} with an environment variable, so sign-in details stay out of the file.
 * "$$" is a literal "$", which lets a value contain "${" without it being read as a variable.
 */
function fromEnvironment(value: string, where: string): string {
  return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string | undefined) => {
    if (match === "$$") return "$";
    const found = process.env[name!];
    if (found === undefined) fail(`${where} uses \${${name}}, but that environment variable is not set.`);
    return found;
  });
}

type Step = (api: StepApi, wait: (ms: number) => Promise<void>) => Promise<void>;

function compileSteps(list: unknown, where: string, insideHidden: boolean): Step[] {
  if (!Array.isArray(list) || list.length === 0) fail(`${where} must be a list with at least one step.`);
  return list.map((entry, index) => {
    const at = `${where} ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${at} must be a step such as "click: Reports".`);
    const item = entry as Record<string, unknown>;
    const kinds = Object.keys(STEP_KEYS).filter((kind) => kind in item);
    if (kinds.length !== 1) fail(`${at} must have exactly one of: ${Object.keys(STEP_KEYS).join(", ")}.`);
    const kind = kinds[0]!;
    const unknown = Object.keys(item).filter((key) => !STEP_KEYS[kind]!.includes(key));
    if (unknown.length > 0) fail(`${at} has an unknown setting "${unknown[0]}". A ${kind} step accepts: ${STEP_KEYS[kind]!.join(", ")}.`);
    const caption = () => {
      if (insideHidden) return typeof item.caption === "string" ? item.caption : "";
      if (typeof item.caption !== "string" || !item.caption.trim()) fail(`${at} needs a caption, the text shown to the viewer.`);
      return item.caption;
    };

    if (kind === "click") {
      const target = toTarget(item.click, `${at} click`);
      const text = caption();
      return (api) => api.click(target, text);
    }
    if (kind === "dblclick") {
      const target = toTarget(item.dblclick, `${at} dblclick`);
      const text = caption();
      return (api) => api.dblclick(target, text);
    }
    if (kind === "select") {
      const target = toTarget(item.select, `${at} select`);
      if (typeof item.option !== "string" || !item.option) fail(`${at} needs an option to choose, as text. If it looks like a number, put it in quotes.`);
      const option = item.option;
      const text = caption();
      return (api) => api.select(target, option, text);
    }
    if (kind === "press") {
      if (typeof item.press !== "string" || !/^[A-Za-z0-9+]{1,40}$/.test(item.press)) fail(`${at} press must be a key such as Enter, Escape or Tab.`);
      const target = toTarget(item.on, `${at} on (the element that receives the key)`);
      const key = item.press;
      const text = caption();
      return (api) => api.press(target, key, text);
    }
    if (kind === "hover") {
      const target = toTarget(item.hover, `${at} hover`);
      const text = caption();
      return (api) => api.hover(target, text);
    }
    if (kind === "fill") {
      const target = toTarget(item.fill, `${at} fill`);
      if (item.value === undefined || item.value === null) fail(`${at} needs a value to type.`);
      // YAML reads 02134 or 1.10 as numbers and would type "2134" or "1.1".
      if (typeof item.value !== "string") fail(`${at} value must be in quotes, so it is typed exactly as written.`);
      const raw = item.value;
      const text = caption();
      return (api) => api.fill(target, fromEnvironment(raw, `${at} value`), text);
    }
    if (kind === "note") {
      if (typeof item.note !== "string" || !item.note.trim()) fail(`${at} note must be the text to show.`);
      const target = item.at === undefined ? undefined : toTarget(item.at, `${at} at`);
      const text = item.note;
      return (api) => api.note(text, target === undefined ? undefined : { at: target });
    }
    if (kind === "chapter") {
      if (typeof item.chapter !== "string" || !item.chapter.trim()) fail(`${at} chapter must be a title.`);
      const title = item.chapter;
      return async (api) => api.chapter(title);
    }
    if (kind === "wait") {
      const ms = item.wait;
      if (typeof ms !== "number" || !(ms >= 0 && ms <= 60_000)) fail(`${at} wait must be a number of milliseconds up to 60000.`);
      return (_api, wait) => wait(ms);
    }
    if (insideHidden) fail(`${at}: hidden steps cannot contain another hidden block.`);
    const inner = compileSteps(item.hidden, `${at} hidden entry`, true);
    return (api, wait) =>
      api.hidden(async () => {
        for (const run of inner) await run(api, wait);
      });
  });
}

/** Turns the text of a steps file into a demo. Every unknown setting is an error, never ignored. */
export function parseYamlDemo(source: string): DemoDefinition {
  let data: unknown;
  try {
    data = parse(source, { maxAliasCount: 0, schema: "core" });
  } catch (error) {
    fail(`The steps file is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("The steps file must have a url and a list of steps.");
  const { steps, ...rest } = data as Record<string, unknown>;
  for (const key of Object.keys(rest)) if (!OPTION_KEYS.has(key)) fail(`Unknown setting "${key}" in the steps file.`);
  const options = rest as unknown as DemoOptions;
  if (typeof options.url === "string") options.url = fromEnvironment(options.url, "url");
  const compiled = compileSteps(steps, "steps entry", false);
  const shows = (list: unknown): boolean =>
    Array.isArray(list) && list.some((entry) => entry && typeof entry === "object" && ["click", "dblclick", "fill", "select", "press", "hover", "note"].some((kind) => kind in entry));
  if (!shows(steps)) fail("The steps file needs at least one step that shows a screen: click, fill, select, press, hover or note.");
  return demo(options, async ({ page, step }) => {
    for (const run of compiled) await run(step, (ms) => page.waitForTimeout(ms));
  });
}

export function loadYamlDemo(file: string): DemoDefinition {
  return parseYamlDemo(readFileSync(file, "utf8"));
}

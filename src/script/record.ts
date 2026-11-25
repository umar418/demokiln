import type { BrowserContext } from "playwright";
import { stringify } from "yaml";

const PASSWORD_PLACEHOLDER = "${DEMO_PASSWORD}";

export interface RecordedStep {
  kind: "click" | "dblclick" | "fill" | "select" | "press";
  /** On-screen text, or a selector prefixed with "css=". */
  target: string;
  /** Typed text for fill, the chosen option for select, the key for press. */
  value?: string;
}

/** Runs in every page of the recording browser and reports what the person does. */
/* c8 ignore start */
function recorderScript(): void {
  const send = (step: unknown) => {
    const report = (window as unknown as { __demokilnRecord?: (json: string) => void }).__demokilnRecord;
    if (report) report(JSON.stringify(step));
  };
  const plain = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
  const usable = (name: string) => name.length > 0 && name.length <= 60 && !/^[#.\[]|^css=|\$/.test(name);
  const visible = (element: Element) => element.getClientRects().length > 0;

  /** A selector that matches this element and nothing else. */
  const selectorFor = (element: Element): string => {
    const only = (selector: string) => {
      try {
        return document.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    };
    if (element.id && only(`#${CSS.escape(element.id)}`)) return `css=#${CSS.escape(element.id)}`;
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && node !== document.documentElement && parts.length < 14) {
      if (node.id && only(`#${CSS.escape(node.id)}`)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      if (only(parts.join(" > "))) break;
      node = parent;
    }
    return `css=${parts.join(" > ")}`;
  };

  const CLICKABLE = 'button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], input[type="checkbox"], input[type="radio"], summary';
  /** The name a person would call it: its label or its own text, as written rather than as styled. */
  const nameOf = (element: Element): string => {
    const labelled = plain(element.getAttribute("aria-label"));
    if (labelled) return labelled;
    const input = element as HTMLInputElement;
    if (element.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio")) return plain(input.labels?.[0]?.textContent);
    if (element.tagName === "INPUT") return plain(input.value);
    return plain(element.textContent);
  };
  /** Text is only a safe way to find something if nothing else visible shares it. */
  const describe = (element: Element, name: string, among: string): string => {
    if (!usable(name)) return selectorFor(element);
    const sharing = Array.from(document.querySelectorAll(among)).filter((other) => visible(other) && nameOf(other) === name);
    return sharing.length === 1 ? name : selectorFor(element);
  };

  // A field that has ever been a password field stays secret, even after "show password" turns it into text.
  const secrets = new WeakSet<Element>();
  const noteSecret = (target: EventTarget | null) => {
    const element = target as HTMLInputElement | null;
    if (element && element.tagName === "INPUT" && element.type === "password") secrets.add(element);
  };
  document.addEventListener("focusin", (event) => noteSecret(event.target), true);
  document.addEventListener("input", (event) => noteSecret(event.target), true);
  const isSecret = (element: HTMLInputElement) =>
    secrets.has(element) ||
    element.type === "password" ||
    /password|one-time-code|cc-/.test(element.autocomplete || "") ||
    /pass|pwd|secret|token|otp|cvv|cvc|card.?num|ssn/i.test(`${element.name || ""} ${element.id || ""}`);

  const fieldName = (element: HTMLElement) => {
    const input = element as HTMLInputElement;
    const label = plain(input.labels?.[0]?.textContent) || plain(element.getAttribute("aria-label")) || plain(element.getAttribute("placeholder"));
    if (!usable(label)) return selectorFor(element);
    const sharing = Array.from(document.querySelectorAll("input, textarea, select, [contenteditable]")).filter((other) => {
      const o = other as HTMLInputElement;
      return visible(other) && (plain(o.labels?.[0]?.textContent) || plain(other.getAttribute("aria-label")) || plain(other.getAttribute("placeholder"))) === label;
    });
    return sharing.length === 1 ? label : selectorFor(element);
  };

  let pendingEnter: HTMLElement | null = null;

  document.addEventListener(
    "click",
    (event) => {
      const origin = event.target as Element | null;
      if (!origin || !origin.closest) return;
      const element = origin.closest(CLICKABLE) ?? origin;
      const tag = element.tagName.toLowerCase();
      // Pressing Enter in a form clicks its submit button for the person; that click is the action.
      if (event.detail === 0 && pendingEnter) pendingEnter = null;
      // Clicking into a field is part of typing or choosing, which is reported separately.
      if (["textarea", "select", "option", "label", "html", "body"].includes(tag)) return;
      if (tag === "input" && !["submit", "button", "checkbox", "radio"].includes((element as HTMLInputElement).type)) return;
      if ((element as HTMLElement).isContentEditable) return;
      send({ kind: "click", target: describe(element, nameOf(element), CLICKABLE) });
    },
    true,
  );
  document.addEventListener(
    "dblclick",
    (event) => {
      const origin = event.target as Element | null;
      if (!origin || !origin.closest) return;
      const element = origin.closest(CLICKABLE) ?? origin;
      send({ kind: "dblclick", target: describe(element, nameOf(element), CLICKABLE) });
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      const element = event.target as HTMLInputElement | null;
      if (!element) return;
      if (element.tagName === "SELECT") {
        const chosen = (element as unknown as HTMLSelectElement).selectedOptions[0];
        if (chosen) send({ kind: "select", target: fieldName(element), value: plain(chosen.label || chosen.textContent) });
        return;
      }
      if (!/^(INPUT|TEXTAREA)$/.test(element.tagName)) return;
      if (["checkbox", "radio", "file", "submit", "button"].includes(element.type)) return;
      // A typed password is never written down; the steps file refers to an environment variable instead.
      send({ kind: "fill", target: fieldName(element), value: isSecret(element) ? "${DEMO_PASSWORD}" : element.value });
    },
    true,
  );

  // Rich-text areas do not report "change", so their text is read when the person leaves them.
  const edited = new WeakMap<Element, string>();
  document.addEventListener(
    "focusin",
    (event) => {
      const element = event.target as HTMLElement | null;
      if (element?.isContentEditable) edited.set(element, element.innerText);
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (event) => {
      const element = event.target as HTMLElement | null;
      if (!element?.isContentEditable || !edited.has(element)) return;
      if (edited.get(element) !== element.innerText) send({ kind: "fill", target: fieldName(element), value: element.innerText });
      edited.delete(element);
    },
    true,
  );

  // Enter in a field: if it presses a submit button, that click is recorded instead.
  const sendEnter = () => {
    if (!pendingEnter) return;
    const element = pendingEnter;
    pendingEnter = null;
    send({ kind: "press", target: fieldName(element), value: "Enter" });
  };
  document.addEventListener(
    "keydown",
    (event) => {
      const element = event.target as HTMLElement | null;
      if (event.key !== "Enter" || !element || element.tagName !== "INPUT") return;
      if (["checkbox", "radio", "submit", "button"].includes((element as HTMLInputElement).type)) return;
      pendingEnter = element;
      setTimeout(sendEnter, 0);
    },
    true,
  );
  document.addEventListener(
    "submit",
    (event) => {
      // A form submitted with no button: record the key now, before the page may navigate away.
      if (pendingEnter && !(event as SubmitEvent).submitter) sendEnter();
    },
    true,
  );
}
/* c8 ignore stop */

const KINDS = ["click", "dblclick", "fill", "select", "press"];

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Starts recording in a browser context. Every page opened in it reports what the person does. */
export async function attachRecorder(context: BrowserContext, onStep: (step: RecordedStep) => void): Promise<void> {
  // Reports are handled one at a time, in the order they arrive, so the file lists actions in the order they happened.
  let queue: Promise<void> = Promise.resolve();
  const handle = async (source: { frame: import("playwright").Frame }, json: unknown): Promise<void> => {
    // The page is untrusted: accept only the expected shape and sizes.
    try {
      const step = JSON.parse(String(json).slice(0, 4000)) as RecordedStep;
      if (!KINDS.includes(step.kind) || typeof step.target !== "string" || !step.target || step.target.length > 300) return;
      if (hasControlCharacter(step.target)) return;
      if (step.kind === "click" || step.kind === "dblclick") return onStep({ kind: step.kind, target: step.target });
      if (typeof step.value !== "string") return;
      if (step.kind === "press") return step.value === "Enter" ? onStep({ kind: "press", target: step.target, value: "Enter" }) : undefined;
      let value = step.value.slice(0, 1000);
      if (step.kind === "select") return onStep({ kind: "select", target: step.target, value });
      if (value !== PASSWORD_PLACEHOLDER) {
        // The page may claim a password is ordinary text. Anything that matches what is
        // currently in a password field is never written down, whatever the page says.
        const secrets = await source.frame
          .evaluate(() => Array.from(document.querySelectorAll('input[type="password"]')).map((e) => (e as HTMLInputElement).value).filter(Boolean))
          .catch(() => [] as string[]);
        // "$" is doubled so recorded text can never be read back as an environment variable.
        value = secrets.includes(value) ? PASSWORD_PLACEHOLDER : value.replace(/\$/g, "$$$$");
      }
      onStep({ kind: "fill", target: step.target, value });
    } catch {
      /* ignore anything malformed */
    }
  };
  await context.exposeBinding("__demokilnRecord", (source, json: unknown) => {
    queue = queue.then(() => handle(source, json));
    return queue;
  });
  await context.addInitScript(recorderScript);
}

/**
 * Tidies what was reported: typing into one field reports every change, so only the final
 * value is kept; a double-click also reports two clicks, which are dropped.
 */
export function tidy(steps: RecordedStep[]): RecordedStep[] {
  const out: RecordedStep[] = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (step.kind === "fill" && last?.kind === "fill" && last.target === step.target) {
      out[out.length - 1] = step;
    } else if (step.kind === "dblclick") {
      for (let i = 0; i < 2; i++) {
        const previous = out[out.length - 1];
        if (previous?.kind === "click" && previous.target === step.target) out.pop();
      }
      out.push(step);
    } else {
      out.push(step);
    }
  }
  return out;
}

function describe(target: string): string {
  return target.startsWith("css=") ? "this" : `“${target}”`;
}

/** Writes recorded steps as a steps file. Captions are a starting point for the author to reword. */
export function toStepsFile(url: string, steps: RecordedStep[], title = "A quick tour"): string {
  const list = tidy(steps).map((step) => {
    if (step.kind === "fill") return { fill: step.target, value: step.value ?? "", caption: `Fill in ${describe(step.target)}` };
    if (step.kind === "select") return { select: step.target, option: step.value ?? "", caption: `Choose “${step.value ?? ""}”` };
    if (step.kind === "press") return { press: "Enter", on: step.target, caption: "Press Enter" };
    if (step.kind === "dblclick") return { dblclick: step.target, caption: `Double-click ${describe(step.target)}` };
    return { click: step.target, caption: `Click ${describe(step.target)}` };
  });
  return "# Recorded with demokiln record. Reword the captions, then run: demokiln build <this file>\n" + stringify({ url, title, steps: list }, { lineWidth: 0 });
}

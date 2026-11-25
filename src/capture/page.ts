import type { BrowserContext, Locator, Page, Request } from "playwright";

/** Fields whose contents must never appear in a capture, whatever the script says. */
export const ALWAYS_MASKED =
  'input[type="password"], input[autocomplete*="cc-"], input[autocomplete="one-time-code"], ' +
  'input[autocomplete="current-password"], input[autocomplete="new-password"], [data-dk-mask], ' +
  ["cardnumber", "card-number", "card_number", "ccnum", "cc-num", "cvv", "cvc", "securitycode", "security-code"]
    .flatMap((word) => [`input[name*="${word}" i]`, `input[id*="${word}" i]`])
    .join(", ");

/**
 * Marks fields that hold a payment card number (13 to 19 digits that pass the standard
 * check digit) so they are covered even when the page gives no hint about what they are.
 */
export async function markCardFields(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const field of Array.from(document.querySelectorAll("input:not([data-dk-mask]), textarea:not([data-dk-mask])"))) {
      const digits = ((field as HTMLInputElement).value ?? "").replace(/[\s-]/g, "");
      if (!/^\d{13,19}$/.test(digits)) continue;
      let sum = 0;
      for (let i = 0; i < digits.length; i++) {
        let digit = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 1) {
          digit *= 2;
          if (digit > 9) digit -= 9;
        }
        sum += digit;
      }
      if (sum % 10 === 0) field.setAttribute("data-dk-mask", "");
    }
  });
}

/** Swaps text in the rendered page. Runs before every capture because apps re-render. */
export async function applyReplacements(page: Page, rules: Record<string, string>): Promise<void> {
  const pairs = Object.entries(rules);
  if (pairs.length === 0) return;
  await page.evaluate((pairs) => {
    const swap = (text: string) => {
      let out = text;
      for (const [from, to] of pairs) out = out.split(from).join(to);
      return out;
    };
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const parent = node.parentElement;
      if (parent && /^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName)) continue;
      const next = swap(node.nodeValue ?? "");
      if (next !== node.nodeValue) node.nodeValue = next;
    }
    for (const field of Array.from(document.querySelectorAll("input, textarea"))) {
      const input = field as HTMLInputElement;
      if (input.type === "password" || input.type === "file") continue;
      const next = swap(input.value);
      if (next !== input.value) input.value = next;
    }
    // Attributes a person can end up seeing: text shown for a missing image, tooltips, placeholders.
    for (const element of Array.from(document.querySelectorAll("[alt], [title], [placeholder], [aria-label]"))) {
      for (const attr of ["alt", "title", "placeholder", "aria-label"]) {
        const value = element.getAttribute(attr);
        if (value) {
          const next = swap(value);
          if (next !== value) element.setAttribute(attr, next);
        }
      }
    }
  }, pairs);
}

/**
 * All text a capture could show, as a person would read it. Text in neighbouring inline
 * elements is joined, so a value split across several spans is seen whole; text added by
 * styles (::before and ::after) and field values are included. Anything under a masked
 * selector and password fields are left out. Used only for the credential scan.
 */
export async function collectText(page: Page, maskSelectors: string[]): Promise<string> {
  return page.evaluate(
    ({ maskSelectors, alwaysMasked }) => {
      const masked = new Set<Element>();
      for (const selector of [...maskSelectors, alwaysMasked]) {
        try {
          document.querySelectorAll(selector).forEach((e) => masked.add(e));
        } catch {
          /* an invalid selector is reported by the capture step, not here */
        }
      }
      const isMasked = (start: Element | null) => {
        for (let e = start; e; e = e.parentElement) if (masked.has(e)) return true;
        return false;
      };
      // The nearest ancestor that starts a new line. Text inside one such block reads as one run.
      const blocks = new Map<Element, Element>();
      const blockOf = (start: Element): Element => {
        const known = blocks.get(start);
        if (known) return known;
        let e: Element = start;
        while (e.parentElement) {
          const display = getComputedStyle(e).display;
          if (!display.startsWith("inline") && display !== "contents") break;
          e = e.parentElement;
        }
        blocks.set(start, e);
        return e;
      };
      const pseudo = (element: Element, which: string) => {
        const content = getComputedStyle(element, which).content;
        if (!content || content === "none" || content === "normal") return "";
        // Computed content is a list of quoted strings, possibly with counters or images between them.
        return (content.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((s) => s.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
      };

      let out = "";
      let lastBlock: Element | null = null;
      const add = (text: string, block: Element) => {
        if (!text) return;
        if (lastBlock !== block) out += "\n";
        out += text;
        lastBlock = block;
      };
      let budget = 20000;
      const visit = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const parent = node.parentElement;
          if (parent) add(node.nodeValue ?? "", blockOf(parent));
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const element = node as Element;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(element.tagName)) return;
        if (masked.has(element)) {
          lastBlock = null;
          return;
        }
        const check = budget-- > 0;
        if (check) add(pseudo(element, "::before"), blockOf(element));
        for (const child of Array.from(element.childNodes)) visit(child);
        if (element.shadowRoot) for (const child of Array.from(element.shadowRoot.childNodes)) visit(child);
        if (check) add(pseudo(element, "::after"), blockOf(element));
      };
      visit(document.documentElement);

      const parts = [out];
      for (const field of Array.from(document.querySelectorAll("input, textarea"))) {
        const input = field as HTMLInputElement;
        if (input.type === "password" || isMasked(input)) continue;
        if (input.value) parts.push(input.value);
        const placeholder = input.getAttribute("placeholder");
        if (placeholder) parts.push(placeholder);
      }
      return parts.join("\n");
    },
    { maskSelectors, alwaysMasked: ALWAYS_MASKED },
  );
}

/**
 * Installed in every page before its own code runs. Counts what the app has in flight
 * (short timers, animation frames, changes to the page) so a capture can wait for it,
 * fixes the random number sequence so repeated builds match, and nothing else.
 */
/* c8 ignore start */
function activityScript(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__dkAct) return;
  const act = { mutations: 0, timers: 0, frames: 0 };
  const repeats = new Map<string, number>();
  Object.defineProperty(window, "__dkAct", { value: act });
  Object.defineProperty(window, "__dkActReset", { value: () => repeats.clear() });
  try {
    new MutationObserver((list) => {
      act.mutations += list.length;
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    /* the page stays usable without it */
  }

  // The same seed on every load: an app that draws random ids gets the same ones each build.
  let seed = 0x9e3779b9;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  const setT = window.setTimeout.bind(window);
  const clearT = window.clearTimeout.bind(window);
  const live = new Set<number>();
  (window as unknown as { setTimeout: unknown }).setTimeout = function (handler: unknown, delay?: number, ...args: unknown[]) {
    if (typeof handler !== "function") return (setT as (...a: unknown[]) => number)(handler, delay, ...args);
    const wait = Number(delay) || 0;
    // A timer that keeps re-arming itself is a poll or a clock, not a load in progress.
    const key = String(handler).slice(0, 200) + "|" + wait;
    const seen = (repeats.get(key) ?? 0) + 1;
    repeats.set(key, seen);
    const tracked = wait <= 5000 && seen <= 3;
    const id: number = setT(function (this: unknown) {
      if (tracked && live.delete(id)) act.timers--;
      return (handler as (...a: unknown[]) => unknown).apply(this, args);
    }, delay) as unknown as number;
    if (tracked) {
      live.add(id);
      act.timers++;
    }
    return id;
  };
  (window as unknown as { clearTimeout: unknown }).clearTimeout = function (id?: number) {
    if (id !== undefined && live.delete(id)) act.timers--;
    return clearT(id);
  };

  const requestF = window.requestAnimationFrame.bind(window);
  const cancelF = window.cancelAnimationFrame.bind(window);
  const frames = new Set<number>();
  window.requestAnimationFrame = function (callback: FrameRequestCallback) {
    const id = requestF(function (time) {
      if (frames.delete(id)) act.frames--;
      return callback(time);
    });
    frames.add(id);
    act.frames++;
    return id;
  };
  window.cancelAnimationFrame = function (id: number) {
    if (frames.delete(id)) act.frames--;
    return cancelF(id);
  };
}
/* c8 ignore stop */

export interface Activity {
  /** Requests the page has sent that have not finished. */
  pending: () => number;
}

/** Starts watching a browser context for work in flight. Call once, before opening a page. */
export async function watchActivity(context: BrowserContext): Promise<Activity> {
  await context.addInitScript(activityScript);
  const started = new Map<Request, number>();
  context.on("request", (request) => {
    if (!["websocket", "eventsource"].includes(request.resourceType())) started.set(request, Date.now());
  });
  const done = (request: Request) => started.delete(request);
  context.on("requestfinished", done);
  context.on("requestfailed", done);
  return {
    pending: () => {
      const now = Date.now();
      let count = 0;
      // A request open for a long time is a stream or long poll, not a page load.
      for (const [request, at] of started) {
        if (now - at > 10_000) started.delete(request);
        else count++;
      }
      return count;
    },
  };
}

/**
 * Waits until the app has finished what it was doing and the screen has stopped changing:
 * no requests, short timers or animation frames in flight, no changes to the page for a
 * quarter of a second, fonts ready, and two consecutive captures identical.
 * Returns false if that did not happen within the time allowed.
 */
export async function settle(page: Page, timeout: number, activity?: Activity): Promise<boolean> {
  const start = Date.now();
  const deadline = start + timeout;
  await page.waitForLoadState("load", { timeout }).catch(() => {});
  await page.evaluate(() => (window as unknown as { __dkActReset?: () => void }).__dkActReset?.()).catch(() => {});

  let lastMutations = -1;
  let quietSince = 0;
  let quiet = false;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => {
        const act = (window as unknown as { __dkAct?: { mutations: number; timers: number; frames: number } }).__dkAct;
        return act ? { mutations: act.mutations, timers: act.timers, frames: act.frames } : null;
      })
      .catch(() => null);
    const now = Date.now();
    const working =
      (activity?.pending() ?? 0) > 0 ||
      (state !== null &&
        (state.timers > 0 ||
          // A page that animates forever always has a frame queued, so frames only count briefly.
          (state.frames > 0 && now - start < 2000)));
    // A page that keeps rewriting itself (a clock, a ticker) never goes quiet. After a short
    // while that alone no longer holds things up: whether the screen is stable is then decided
    // by comparing captures below.
    const changing = state !== null && state.mutations !== lastMutations && now - start < 1500;
    const busy = working || changing;
    if (state) lastMutations = state.mutations;
    if (busy) quietSince = 0;
    else if (!quietSince) quietSince = now;
    if (quietSince && now - quietSince >= 250) {
      quiet = true;
      break;
    }
    await page.waitForTimeout(50);
  }
  if (!quiet) return false;

  await page.evaluate(() => (document as Document).fonts?.ready).catch(() => {});
  let previous: Buffer | null = null;
  // Always allow a few frames for the stability check, even if the wait above used the time up.
  const frameDeadline = Math.max(deadline, Date.now() + 600);
  while (Date.now() < frameDeadline) {
    const shot = await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
    if (previous && previous.equals(shot)) return true;
    previous = shot;
    await page.waitForTimeout(80);
  }
  return false;
}

export interface Blocker {
  description: string;
}

/**
 * Says what is drawn on top of an element's centre, or null if the element itself is there.
 * A hotspot on a covered element would point at whatever covers it.
 */
export async function coveredBy(target: Locator): Promise<string | null> {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
    // Follow shadow roots down to the innermost element at that point.
    let top: Element | null = document.elementFromPoint(x, y);
    while (top?.shadowRoot) {
      const inner: Element | null = top.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    if (!top) return "nothing (it is outside the visible area)";
    const inside = (child: Node | null, parent: Node) => {
      for (let node: Node | null = child; node; node = node.parentNode ?? (node as ShadowRoot).host ?? null) if (node === parent) return true;
      return false;
    };
    if (inside(top, element) || inside(element, top)) return null;
    // A label covers its own field by design.
    if (top instanceof HTMLLabelElement && top.control === element) return null;
    const id = top.id ? `#${top.id}` : "";
    const text = (top.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return `<${top.tagName.toLowerCase()}${id}>${text ? ` “${text}”` : ""}`;
  });
}

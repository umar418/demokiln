import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DemoConfigError, DemoStepError, parseYamlDemo, runDemo } from "../src/index.js";
import { toTarget } from "../src/script/yaml.js";
import { startFixture } from "./helpers.js";

let base = "";
let stop: () => Promise<void>;
beforeAll(async () => ({ url: base, stop } = await startFixture()));
afterAll(() => stop());

const file = (steps: string, extra = "") => `url: ${base}/index.html\nscale: 1\nstepTimeout: 1500\n${extra}steps:\n${steps}`;

describe("steps file", () => {
  it("runs a demo written as plain steps, finding elements by what is on screen", async () => {
    const result = await runDemo(
      parseYamlDemo(
        file(
          [
            "  - note: Welcome to Northwind",
            "  - chapter: Reports",
            "  - click: Reports",
            "    caption: Open your reports",
            "  - fill: From",
            "    value: 2026-01-01",
            "    caption: Pick a start date",
            "  - click: Apply",
            "    caption: Apply the filter",
            '  - note: Your orders appear here.',
            '    at: "#result"',
          ].join("\n"),
          "title: Plain steps\n",
        ),
      ),
    );
    expect(result.title).toBe("Plain steps");
    expect(result.steps.map((s) => s.kind)).toEqual(["note", "click", "fill", "click", "note", "end"]);
    expect(result.steps.map((s) => s.chapter)).toEqual([undefined, "Reports", "Reports", "Reports", "Reports", "Reports"]);
    expect(result.steps[1]!.hotspot).toBeDefined();
    expect(result.steps[0]!.hotspot).toBeUndefined();
  });

  it("runs hidden steps and reads values from the environment", async () => {
    process.env.DEMOKILN_TEST_DATE = "2026-03-03";
    const result = await runDemo(
      parseYamlDemo(
        file(
          [
            "  - hidden:",
            "      - click: Reports",
            "      - fill: From",
            "        value: ${DEMOKILN_TEST_DATE}",
            "  - click: Apply",
            "    caption: Apply the filter",
          ].join("\n"),
        ),
      ),
    );
    expect(result.steps.map((s) => s.caption)).toEqual(["Apply the filter", "That’s the tour."]);
    delete process.env.DEMOKILN_TEST_DATE;
  });

  it("fails with the step number when text matches nothing or more than one element", async () => {
    const missing = await runDemo(parseYamlDemo(file("  - click: No Such Button\n    caption: Press it"))).catch((e) => e);
    expect(missing).toBeInstanceOf(DemoStepError);
    expect(missing.message).toMatch(/Step 1 .*nothing visible on the page matches “No Such Button”/);

    const twice = `url: ${base}/twice.html\nscale: 1\nstepTimeout: 1500\nsteps:\n  - click: Save\n    caption: Save it`;
    const ambiguous = await runDemo(parseYamlDemo(twice)).catch((e) => e);
    expect(ambiguous).toBeInstanceOf(DemoStepError);
    expect(ambiguous.message).toMatch(/2 elements match “Save” \(a button\)/);
  });

  it("rejects mistakes in the file instead of ignoring them", () => {
    const bad: [string, RegExp][] = [
      ["steps:\n  - click: A\n    caption: x", /url must start/],
      [`url: ${"http://x.test"}\nsteps: []`, /at least one step/],
      [`url: http://x.test\ncolour: red\nsteps:\n  - note: hi`, /Unknown setting "colour"/],
      [`url: http://x.test\nsteps:\n  - click: A`, /entry 1 needs a caption/],
      [`url: http://x.test\nsteps:\n  - click: A\n    caption: x\n    delay: 3`, /unknown setting "delay"/],
      [`url: http://x.test\nsteps:\n  - click: A\n    fill: B\n    caption: x`, /exactly one of/],
      [`url: http://x.test\nsteps:\n  - fill: A\n    caption: x`, /needs a value/],
      [`url: http://x.test\nsteps:\n  - fill: A\n    value: \${DEMOKILN_NOT_SET_ANYWHERE}\n    caption: x`, /./],
      [`url: http://x.test\nsteps:\n  - wait: forever`, /wait must be a number/],
      [`url: http://x.test\nsteps:\n  - hidden:\n      - hidden:\n          - click: A`, /cannot contain another hidden/],
      [`url: http://x.test\nsteps: &a\n  - note: *a`, /./],
      ["url: [unclosed", /not valid YAML|must have a url/],
    ];
    for (const [source, message] of bad.filter(([s]) => !s.includes("NOT_SET"))) {
      expect(() => parseYamlDemo(source), source).toThrow(DemoConfigError);
      expect(() => parseYamlDemo(source), source).toThrow(message);
    }
  });

  it("reports a missing environment variable when the step runs, naming the variable but not other values", async () => {
    const source = file("  - click: Reports\n    caption: Open\n  - fill: From\n    value: ${DEMOKILN_NOT_SET_ANYWHERE}\n    caption: Type");
    const error = await runDemo(parseYamlDemo(source)).catch((e) => e);
    expect(String(error.message)).toContain("DEMOKILN_NOT_SET_ANYWHERE");
  });

  it("treats #id, .class, [attr] and css= as selectors and everything else as on-screen text", () => {
    expect(toTarget("#result", "x")).toBe("#result");
    expect(toTarget(".card", "x")).toBe(".card");
    expect(toTarget("[data-x]", "x")).toBe("[data-x]");
    expect(toTarget("css=nav a", "x")).toBe("nav a");
    expect(toTarget("Reports", "x")).toEqual({ text: "Reports" });
  });
});

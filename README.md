# Demokiln

**Interactive product demos, built from a script and rebuilt when your product changes.**

Demokiln is a free, open-source alternative to paid demo tools such as Arcade, Storylane, Supademo and Navattic. You describe the steps once. Demokiln walks through your real app, captures each screen, and writes one self-contained HTML file with clickable hotspots and captions.

**Status: early, not yet released.** What works today is listed below. The rest of the plan is under [Not built yet](#not-built-yet).

## Example

```ts
import { demo } from "demokiln";

export default demo(
  { url: "http://localhost:3000", title: "A quick tour" },
  async ({ page, step }) => {
    await step.click(page.getByRole("link", { name: "Reports" }), "Open your reports");
    await step.fill(page.getByLabel("From"), "2026-01-01", "Pick a start date");
    await step.note("Your orders appear here.", { at: "#result" });
  },
);
```

```bash
npx demokiln build demo.ts
```

The result is `demo.html`: no server, no account, nothing loaded from the network.

## Or write plain steps

No code needed. Elements are found by what is on screen: a button or link name, a field label, or exact text.

```yaml
url: http://localhost:3000
title: A quick tour
steps:
  - click: Reports
    caption: Open your reports
  - fill: From
    value: 2026-01-01
    caption: Pick a start date
  - note: Your orders appear here.
    at: "#result"
```

```bash
npx demokiln build demo.yaml
```

## What works today

- **Steps:** click, double-click, fill, select, press a key, hover, note, hidden setup steps (for signing in), chapters and waits. Written in TypeScript or as a plain YAML steps file.
- **Real pages, not just pictures.** Each screen is kept as the page's real structure, so it stays sharp at any size and the file stays small (the six-screen sample is about 30 KB). Every copy is compared pixel by pixel with a real screenshot taken at the same moment; if they differ by more than a few pixels, the screenshot is used instead and the build says so.
- **The same for every viewer.** Conditions that depend on the viewer (screen density, touch, contrast, colour scheme, scrollbars) are decided at capture time and fixed in the copy.
- **Captures wait for the app.** A screen is captured once requests, short timers and animation frames have finished and two captures in a row are identical. If that does not happen in time, the build warns.
- **Broken steps stop the build** and name the step. So does a target hidden under a banner or a fixed header.
- **Finding things by text.** Only visible elements count. If the text matches more than one distinct element (say a button and a link), the step fails rather than guessing.
- **Privacy.** Password fields and recognised card fields are always covered. `mask` covers anything else and removes its text from the copy; `replace` swaps real text for sample text, including in attributes. The build stops if a likely credential is on screen.
- **A locked-down file.** One HTML file that loads nothing from the network. Captured pages are stripped of scripts and shown in a frame that cannot run code. Captions are plain text.
- **Stale-demo check.** `demokiln check` re-runs the steps against your app. It exits 1 if a step no longer works and 2 if anything differs from the last build: a screen, a caption, where a hotspot points, a chapter or a setting. It writes a before-and-after page.
- **Repeatable.** The app's clock starts at a set date and time and it gets a fixed random sequence, so a page that prints "today" or draws random ids builds the same way twice. Set `time` to choose the date. The clock still runs, so a time shown to the second will differ; mask it.
- **Recorder.** `demokiln record <url>` opens a browser; click through your app and it writes the steps file.
- **Other outputs.** `demokiln export` writes a step-by-step Markdown guide, one image per screen with the click target outlined, and a JSON description.
- **Small screens, autoplay, embedding.** On a phone the player moves in on the part that matters. `autoplay` advances the demo until the viewer takes over. The build prints an iframe snippet for your site.
- **Accessible.** Keyboard control, captions exposed to screen readers, light and dark mode, reduced motion.
- **Commands:** `init`, `record`, `build`, `check`, `export`, `preview`, `doctor`.

## Limits

- **Values made by your server** (a timestamp or random number in the HTML it sends) cannot be fixed by Demokiln. `check` notices when a screen changes by itself and tells you to `mask` that part.
- **A value typed by a `fill` step appears on the next screen**, so it is part of the demo. Use environment variables and hidden steps for anything private.
- **Screenshots instead of real pages.** Pages with web components that hide their internals, video, or embedded frames are captured as screenshots, which are larger and less sharp when zoomed.
- **The credential and card checks read text and field values.** They cannot read text inside images, and a card field is recognised by its name, its `autocomplete` hint, or a valid card number in it.
- **`replace` works on whole pieces of text.** If the text is split across elements the build stops and asks you to use `mask`.
- **`check` compares screenshots,** so the baseline must come from the same operating system that runs the check. Fonts render differently between macOS, Linux and Windows. Use `--no-visual` to check only that the steps work.
- **Fonts.** Viewers see captured pages with their own fonts if the page relies on fonts installed on your machine rather than web fonts. Hotspots still land on the right element because they are measured live.
- **Windows high-contrast mode.** A viewer using it sees system colour names (such as `Canvas`) in their own palette.
- **The recorder is for your own app.** A page you record can read what you type into it. It never writes down a field that is, or ever was, a password field, but it cannot protect you from a site you do not trust. It does not record hovering, so menus that open on hover need a `hover` step added by hand.

## Not built yet

Branching, phone-sized captures, a ready-made CI action, a visual editor, GIF and MP4 export, and agent integrations.

## How it was tested

Two independent testers attacked the tool with about 145 cases: one for security and privacy, one for wrong or misleading output. They reproduced 40 defects, among them a build that could be made to contact other machines, credentials that slipped past the scan, screens captured before the app had finished loading, and a stale-demo check that missed small changes. All were fixed, and each has a regression test. Neither tester found a way to run code in, or get a network request out of, a finished demo.

## Requirements

Node 20 or newer, and Playwright with Chromium (`npx playwright install chromium`).

## License

MIT

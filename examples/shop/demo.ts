import { demo } from "demokiln";

// A tour of the small sample shop in fixtures/shop.
// Serve it first:  npx demokiln preview fixtures/shop/index.html -p 4319
export default demo(
  {
    url: "http://127.0.0.1:4319/index.html",
    title: "Northwind in one minute",
    replace: { "Real Customer Ltd": "Acme Inc" },
    cta: { label: "Start free", url: "https://example.com/signup" },
  },
  async ({ page, step }) => {
    await step.note("This is your home screen. The week's numbers are always up to date.");
    await step.click(page.getByRole("link", { name: "Reports" }), "Open your reports");
    await step.fill(page.getByLabel("From"), "2026-01-01", "Pick a start date");
    await step.click(page.getByRole("button", { name: "Apply" }), "Apply the filter");
    await step.note("Your orders appear here.", { at: "#result" });
  },
);

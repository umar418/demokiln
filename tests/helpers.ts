import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { serveStatic } from "../src/cli/serve.js";

export const FIXTURE = fileURLToPath(new URL("../fixtures/shop", import.meta.url));

export async function startFixture(): Promise<{ url: string; stop: () => Promise<void> }> {
  const { server, url } = await serveStatic(FIXTURE);
  return { url, stop: () => new Promise<void>((done) => (server as Server).close(() => done())) };
}

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const temp = () => mkdtempSync(join(tmpdir(), "demokiln-"));

/** Serves one page of HTML written for a test. */
export async function servePage(html: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const dir = temp();
  writeFileSync(join(dir, "index.html"), html);
  const { server, url } = await serveStatic(dir);
  return { url: `${url}/index.html`, stop: () => new Promise<void>((done) => (server as Server).close(() => done())) };
}

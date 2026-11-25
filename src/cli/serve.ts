import { createServer, type Server } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/** Maps a request path to a file inside root, or undefined if it would escape root. */
export function resolveInside(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const base = resolve(root);
  const target = resolve(base, "." + (decoded.startsWith("/") ? decoded : "/" + decoded));
  if (target !== base && !target.startsWith(base + sep)) return undefined;
  return target;
}

/** A small read-only static server bound to this machine only. */
export function serveStatic(root: string, port = 0, only?: string): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    let file = resolveInside(root, request.url ?? "/");
    try {
      // When one file is being previewed, its neighbours (scripts, baselines, anything else) stay private.
      if (only !== undefined && file !== resolve(root, only)) throw new Error("refused");
      if (!file || (request.method !== "GET" && request.method !== "HEAD")) throw new Error("refused");
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
      // A link inside the folder must not lead out of it.
      const real = await realpath(file);
      const realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error("refused");
      const body = await readFile(real);
      response.writeHead(200, {
        "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      ok({ server, url: `http://127.0.0.1:${actual}` });
    });
  });
}

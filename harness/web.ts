import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { Effect } from "effect";

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
};

export const startWeb = Effect.acquireRelease(
  Effect.tryPromise(async () => {
    const root = resolve(".cache/stremio-web/build");
    await readFile(`${root}/index.html`);
    const server = createServer(async (req, res) => {
      try {
        const path = resolve(
          root,
          `.${new URL(req.url ?? "/", "http://localhost").pathname}`,
        );
        if (path !== root && !path.startsWith(root + sep)) {
          res.writeHead(403).end();
          return;
        }
        const file = path === root ? `${root}/index.html` : path;
        const body = await readFile(file);
        res
          .writeHead(200, {
            "content-type": types[extname(file)] ?? "application/octet-stream",
            "cache-control": "no-store",
          })
          .end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No Web listen address");
    return {
      origin: `http://127.0.0.1:${address.port}`,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((e) => (e ? reject(e) : resolve()));
        }),
    };
  }),
  (server) => Effect.promise(server.close),
);

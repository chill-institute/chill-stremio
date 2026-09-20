import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Effect, ManagedRuntime, type Layer } from "effect";
import sdk, { type Manifest } from "stremio-addon-sdk";
import { Engine, type EngineError } from "./engine.ts";
import { createLibrary } from "./library.ts";

// Stremio clients compare manifest versions to detect add-on updates, so the
// release version is baked in at image build time; local runs report 0.0.0.
const semver = /^\d+\.\d+\.\d+$/;
const configuredVersion = process.env.CHILL_ADAPTER_VERSION?.trim() ?? "";
export const adapterVersion = semver.test(configuredVersion)
  ? configuredVersion
  : "0.0.0";

export const adapterManifest: Manifest = {
  id: "institute.chill.library",
  version: adapterVersion,
  name: "chill.institute",
  description: "Videos from your selected chill.institute folder.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["chill:file:"],
  catalogs: [
    {
      type: "movie",
      id: "library",
      name: "put.io library",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
      ],
    },
  ],
};

export async function startAdapter(options: {
  layer: Layer.Layer<Engine, EngineError>;
  folderId: bigint;
  port?: number;
}) {
  if (options.folderId < 0n || options.folderId > 9223372036854775807n)
    throw new Error("Invalid folder ID");
  const runtime = ManagedRuntime.make(options.layer);
  try {
    await runtime.runPromise(Engine);
  } catch {
    await runtime.dispose();
    throw new Error("Invalid Engine configuration");
  }
  const library = createLibrary(options.folderId);
  const signals = new AsyncLocalStorage<AbortSignal>();
  const controllers = new Set<AbortController>();
  const run = async <A, E extends { code: string }>(
    effect: Effect.Effect<A, E, Engine>,
  ) => {
    const result = await runtime.runPromise(
      effect.pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, code: error.code }),
        }),
      ),
      { signal: signals.getStore() },
    );
    if (!result.ok) throw new Error(result.code);
    return result.value;
  };
  const builder = new sdk.addonBuilder(adapterManifest);
  builder.defineCatalogHandler(({ type, id, extra }) =>
    run(
      library.catalog({
        type,
        id,
        extra: {
          search: extra.search,
          skip: extra.skip === undefined ? undefined : String(extra.skip),
        },
      }),
    ),
  );
  builder.defineMetaHandler(async (input) => {
    const result = await run(library.meta(input));
    if (!result.meta)
      throw Object.assign(new Error("not_found"), { noHandler: true });
    return { meta: result.meta };
  });
  builder.defineStreamHandler((input) => run(library.streams(input)));
  const router = sdk.getRouter(builder.getInterface());
  const capability = randomBytes(32).toString("base64url");
  const prefix = `/${capability}`;
  let origin = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Access-Control-Allow-Origin", "*");
    const path = request.url ?? "";
    const presented = path.split("/")[1] ?? "";
    const expectedHost = new URL(origin).host;
    if (
      request.headers.host !== expectedHost ||
      path.length > 4096 ||
      Buffer.byteLength(presented) !== Buffer.byteLength(capability) ||
      !timingSafeEqual(Buffer.from(presented), Buffer.from(capability))
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    request.url = path.slice(prefix.length);
    const controller = new AbortController();
    controllers.add(controller);
    const deadline = setTimeout(() => controller.abort(), 10_000);
    const finish = () => {
      clearTimeout(deadline);
      controllers.delete(controller);
      if (!response.writableFinished) controller.abort();
    };
    response.once("close", finish);
    request.once("aborted", () => controller.abort());
    signals.run(controller.signal, () => {
      router(request, response, () => {
        if (!response.destroyed) response.writeHead(404).end();
      });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Adapter did not listen");
    origin = `http://127.0.0.1:${address.port}`;
  } catch {
    server.closeAllConnections();
    server.close();
    await runtime.dispose();
    throw new Error("Adapter could not start");
  }
  let closing: Promise<void> | undefined;
  return {
    origin,
    manifestUrl: `${origin}${prefix}/manifest.json`,
    close: () =>
      (closing ??= (async () => {
        for (const controller of controllers) controller.abort();
        await new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await runtime.dispose();
      })()),
  };
}

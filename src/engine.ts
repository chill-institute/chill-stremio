import {
  PlaybackDelivery,
  UserService,
  type GetFolderResponse,
  type ResolvePlaybackResponse,
} from "@chill-institute/contracts/chill/v4/api_pb";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { Context, Effect, Layer, Schema } from "effect";
import { credentialPattern } from "./credential.ts";

export class EngineError extends Schema.TaggedError<EngineError>()(
  "EngineError",
  {
    code: Schema.Literals([
      "invalid_config",
      "unauthenticated",
      "permission_denied",
      "not_found",
      "resource_exhausted",
      "deadline_exceeded",
      "unavailable",
      "invalid_response",
      "canceled",
      "unknown",
    ]),
  },
) {}

export class Engine extends Context.Service<
  Engine,
  {
    getFolder(id: bigint): Effect.Effect<GetFolderResponse, EngineError>;
    resolvePlayback(
      id: bigint,
    ): Effect.Effect<ResolvePlaybackResponse, EngineError>;
  }
>()("chill-stremio/Engine") {}

const BaseUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }),
);
const Configuration = Schema.Union([
  Schema.Struct({
    baseUrl: BaseUrl,
    token: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8192),
      Schema.isPattern(/^[A-Za-z0-9._~+/-]+=*$/),
    ),
  }),
  Schema.Struct({
    baseUrl: BaseUrl,
    credential: Schema.String.check(Schema.isPattern(credentialPattern)),
  }),
]);

/** A chill bearer, or a Stremio credential that Engine accepts for add-on RPCs only. */
export type EngineAuth =
  | { baseUrl: string; token: string }
  | { baseUrl: string; credential: string };

const maxResponseBytes = 1024 * 1024;

const boundedFetch: typeof globalThis.fetch = async (input, init) => {
  const response = await fetch(input, {
    ...init,
    redirect: "manual",
    credentials: "omit",
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ConnectError("Engine request failed", Code.Unavailable);
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new ConnectError(
          "Engine response rejected",
          Code.ResourceExhausted,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

function mapRpcError(error: unknown): EngineError {
  const code = error instanceof ConnectError ? error.code : Code.Unknown;
  switch (code) {
    case Code.Unauthenticated:
      return new EngineError({ code: "unauthenticated" });
    case Code.PermissionDenied:
      return new EngineError({ code: "permission_denied" });
    case Code.NotFound:
      return new EngineError({ code: "not_found" });
    case Code.ResourceExhausted:
      return new EngineError({ code: "resource_exhausted" });
    case Code.DeadlineExceeded:
      return new EngineError({ code: "deadline_exceeded" });
    case Code.Unavailable:
      return new EngineError({ code: "unavailable" });
    case Code.Canceled:
      return new EngineError({ code: "canceled" });
    case Code.InvalidArgument:
    case Code.Internal:
    case Code.DataLoss:
      return new EngineError({ code: "invalid_response" });
    default:
      return new EngineError({ code: "unknown" });
  }
}

export const createEngineRpc = Effect.fn("Engine.createRpc")(function* (
  configuration: EngineAuth,
) {
  const config = yield* Schema.decodeUnknownEffect(Configuration)(
    configuration,
  ).pipe(Effect.mapError(() => new EngineError({ code: "invalid_config" })));
  const client = createClient(
    UserService,
    createConnectTransport({
      baseUrl: config.baseUrl,
      useBinaryFormat: false,
      useHttpGet: false,
      defaultTimeoutMs: 10_000,
      fetch: boundedFetch,
    }),
  );
  const headers: Record<string, string> =
    "token" in config
      ? { authorization: `Bearer ${config.token}` }
      : { "x-chill-stremio-credential": config.credential };
  return {
    client,
    call: <A>(
      run: (options: {
        signal: AbortSignal;
        headers: Record<string, string>;
      }) => Promise<A>,
    ) =>
      Effect.tryPromise({
        try: (signal) => run({ signal, headers: { ...headers } }),
        catch: mapRpcError,
      }),
  };
});

export function engineLayer(
  configuration: EngineAuth,
): Layer.Layer<Engine, EngineError> {
  return Layer.effect(
    Engine,
    Effect.gen(function* () {
      const rpc = yield* createEngineRpc(configuration);
      return Engine.of({
        getFolder: (id) =>
          rpc.call((options) => rpc.client.getFolder({ id }, options)),
        resolvePlayback: (fileId) =>
          rpc.call((options) =>
            rpc.client.resolvePlayback(
              { fileId, delivery: PlaybackDelivery.HLS },
              options,
            ),
          ),
      });
    }),
  );
}

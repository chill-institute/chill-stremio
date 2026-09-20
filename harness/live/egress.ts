import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Effect, Schema } from "effect";
import { rangeSupported } from "./playback.ts";
import { redactLive } from "./redact.ts";
import { liveVersions } from "./versions.ts";

export class EgressFailure extends Schema.TaggedError<EgressFailure>()(
  "EgressFailure",
  { message: Schema.String },
) {}

export const egressProxyPresent = () => {
  const value = process.env[liveVersions.egressProxyEnv];
  return typeof value === "string" && value.trim().length > 0;
};

export const classifyEgress = (input: {
  defaultRange: number;
  proxyConfigured: boolean;
  proxyRange?: number;
}) => {
  if (!input.proxyConfigured)
    return {
      status: "blocked" as const,
      reason: "single-public-egress",
    };
  if (
    rangeSupported(input.defaultRange) &&
    rangeSupported(input.proxyRange ?? 0)
  )
    return { status: "passed" as const };
  return {
    status: "blocked" as const,
    reason: "second-path-range-failed",
  };
};

const proxyTarget = (value: string) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:")
      return new EgressFailure({
        message: "LIVE_EGRESS_PROXY must be an http CONNECT proxy",
      });
    return {
      hostname: parsed.hostname,
      port: Number(parsed.port || 80),
    };
  } catch {
    return new EgressFailure({
      message: "LIVE_EGRESS_PROXY was not a valid URL",
    });
  }
};

export const rangeStatusViaProxy = Effect.fn("live.egress.rangeViaProxy")(
  function* (url: string, range: string) {
    const proxy = process.env[liveVersions.egressProxyEnv]?.trim();
    if (!proxy)
      return yield* new EgressFailure({
        message: "LIVE_EGRESS_PROXY is missing",
      });
    const parsedProxy = proxyTarget(proxy);
    if (parsedProxy instanceof EgressFailure) return yield* parsedProxy;
    const target = yield* Effect.try({
      try: () => new URL(url),
      catch: () =>
        new EgressFailure({ message: "Download URL was not a valid URL" }),
    });
    if (target.protocol !== "https:")
      return yield* new EgressFailure({
        message: "Download URL was not HTTPS",
      });
    const status = yield* Effect.tryPromise({
      try: (signal) => connectRange(target, range, parsedProxy, signal),
      catch: (cause) =>
        new EgressFailure({ message: redactLive(String(cause)) }),
    });
    return status;
  },
  Effect.timeout("20 seconds"),
);

const connectRange = (
  target: URL,
  range: string,
  proxy: { hostname: string; port: number },
  signal: AbortSignal,
) =>
  new Promise<number>((resolve, reject) => {
    const fail = (cause: unknown) => {
      socket.destroy();
      reject(cause);
    };
    const socket = connect({
      host: proxy.hostname,
      port: proxy.port,
    });
    const onAbort = () => fail(new Error("proxy connect aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}:${target.port || 443}\r\n\r\n`,
      );
    });
    let buffer = Buffer.alloc(0);
    const onProxyData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const status = Number(header.match(/^HTTP\/1\.\d (\d{3})/)?.[1]);
      if (status !== 200) {
        fail(new Error(`proxy CONNECT HTTP ${status || 0}`));
        return;
      }
      socket.off("data", onProxyData);
      const tls = tlsConnect({
        socket,
        servername: target.hostname,
      });
      tls.once("error", fail);
      tls.once("secureConnect", () => {
        const path = `${target.pathname}${target.search}`;
        tls.write(
          `GET ${path} HTTP/1.1\r\nHost: ${target.hostname}\r\nRange: ${range}\r\nConnection: close\r\n\r\n`,
        );
      });
      let response = Buffer.alloc(0);
      tls.on("data", (data: Buffer) => {
        response = Buffer.concat([response, data]);
        const end = response.indexOf("\r\n");
        if (end < 0) return;
        const line = response.subarray(0, end).toString("ascii");
        const code = Number(line.match(/^HTTP\/1\.\d (\d{3})/)?.[1]);
        tls.destroy();
        socket.destroy();
        signal.removeEventListener("abort", onAbort);
        if (!Number.isInteger(code)) {
          reject(new Error("proxy response had no HTTP status"));
          return;
        }
        resolve(code);
      });
    };
    socket.on("data", onProxyData);
  });

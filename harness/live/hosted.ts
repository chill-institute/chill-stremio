import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import {
  create,
  fromJsonString,
  toJsonString,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import * as proto from "@chill-institute/contracts/chill/v4/api_pb";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Option, Schema } from "effect";
import { createEngineRpc, EngineError } from "../../src/engine.ts";
import { startHostedAdapter } from "../../src/hosted.ts";
import { discoveryTargetId } from "../../src/discovery.ts";
import { authorizeChill } from "./auth.ts";
import {
  allowanceLimits,
  readLedger,
  reserve,
  withAllowanceLock,
} from "./allowance.ts";
import { registeredLiveRunner } from "./runner.ts";
import {
  createLiveAttempt,
  trackAcquisition,
  withLiveLifecycle,
  writeRecoveryJournal,
} from "./lifecycle.ts";
import {
  accountInfo,
  cancelTransfers,
  createFolder,
  deleteFiles,
  downloadUrl,
  uploadFile,
} from "./putio.ts";
import { ensureLiveSource, liveFolderName, liveUploadName } from "./source.ts";
import { liveVersions } from "./versions.ts";
import { validateProvenance } from "../provenance.ts";
import { proveHostedBrowserPlayback } from "./hosted-browser.ts";

class HostedProbeFailure extends Schema.TaggedError<HostedProbeFailure>()(
  "HostedProbeFailure",
  { stage: Schema.String, code: Schema.Literal("hosted_probe_failed") },
) {}

const StreamResponse = Schema.Struct({
  streams: Schema.Array(Schema.Struct({ url: Schema.String })),
});

export async function requestSelectedMedia(
  origin: string,
  path: string,
  method: "GET" | "HEAD",
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL(path, origin);
  if (
    url.origin !== origin ||
    url.search ||
    url.hash ||
    !/^\/s\/v4\.local\.[A-Za-z0-9_-]+\/play\/(movie|series)\/[^/]+\/[^/]+\.(mp4|m3u8)$/.test(
      url.pathname,
    )
  )
    throw new HostedProbeFailure({
      stage: "selection-url",
      code: "hosted_probe_failed",
    });
  const response = await fetch(url, {
    method,
    redirect: "manual",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(45_000)])
      : AbortSignal.timeout(45_000),
  });
  try {
    const location = response.headers.get("location");
    if (method === "HEAD") {
      if (
        response.status !== 200 ||
        location ||
        response.headers.get("content-type") !==
          (url.pathname.endsWith(".m3u8")
            ? "application/vnd.apple.mpegurl"
            : "video/mp4")
      )
        throw new HostedProbeFailure({
          stage: "selection-head",
          code: "hosted_probe_failed",
        });
    } else {
      if (response.status !== 302 || !location)
        throw new HostedProbeFailure({
          stage: "selection-get",
          code: "hosted_probe_failed",
        });
      const destination = new URL(location, origin);
      if (
        destination.protocol !== "https:" &&
        !(
          destination.origin === origin &&
          (/^\/s\/v4\.local\.[A-Za-z0-9_-]+\/notice\/(pending|unknown|failed|select-file|unavailable|reconnect)\.mp4$/.test(
            destination.pathname,
          ) ||
            /^\/s\/v4\.local\.[A-Za-z0-9_-]+\/status\/[1-9][0-9]{0,18}\.(mp4|m3u8)$/.test(
              destination.pathname,
            ))
        )
      )
        throw new HostedProbeFailure({
          stage: "selection-redirect",
          code: "hosted_probe_failed",
        });
    }
  } finally {
    await response.body?.cancel();
  }
}

export async function extendForOneAttempt(
  directory: string,
  bytes: number,
  reason: string,
) {
  await withAllowanceLock(directory, async (path) => {
    const current = await readLedger(path);
    const limits = allowanceLimits(current);
    const next = {
      ...current,
      approvedLimits: {
        byteLimit: Math.max(limits.byteLimit, current.reservedBytes + bytes),
        reason: `${current.approvedLimits?.reason ? `${current.approvedLimits.reason}; ` : ""}${reason}`,
      },
    };
    const temporary = `${path}.next`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  });
}

/**
 * Stands in for Engine behind the local adapter: accepts only the generated
 * add-on credential, serves generated discovery and forwards acquisition and
 * playback RPCs to production Engine with the designated account's bearer.
 */
export async function startFixtureDiscoveryProxy(
  token: string,
  credential: string,
  sourceUrl: string,
  bytes: number,
  destination: bigint,
  observeTransfer: (transfer: proto.Transfer) => Promise<void>,
  engineBaseUrl = "https://api.chill.institute/v4",
) {
  const rpc = await Effect.runPromise(
    createEngineRpc({ baseUrl: engineBaseUrl, token }),
  );
  const calls = {
    addTransfer: 0,
    getTransfer: 0,
    getFolder: 0,
    resolvePlayback: 0,
  };
  const transferIds: bigint[] = [];
  const controllers = new Set<AbortController>();
  let acquisitionClaimed = false;
  let origin = "";
  const server = createServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 10000);
    response.once("close", () => {
      clearTimeout(timer);
      controllers.delete(controller);
      controller.abort();
    });
    const send = <D extends DescMessage>(
      schema: D,
      message: MessageShape<D>,
    ) => {
      response.setHeader("content-type", "application/json");
      response.end(toJsonString(schema, message));
    };
    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect, { signal: controller.signal });
    void (async () => {
      if (
        request.headers.host !== new URL(origin).host ||
        request.method !== "POST" ||
        request.headers.authorization !== undefined ||
        request.headers["x-chill-stremio-credential"] !== credential
      )
        throw new Error("rejected");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > 16384) throw new Error("rejected");
        chunks.push(buffer);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      switch (request.url) {
        case "/chill.v4.UserService/GetMovies":
          fromJsonString(proto.GetMoviesRequestSchema, body);
          send(
            proto.GetMoviesResponseSchema,
            create(proto.GetMoviesResponseSchema, {
              movies: [
                {
                  id: "owned-live-fixture",
                  title: "Owned generated fixture",
                  year: 2026,
                  overview:
                    "Generated discovery fixture; acquisition uses real Engine and put.io.",
                },
              ],
            }),
          );
          return;
        case "/chill.v4.UserService/Search": {
          const input = fromJsonString(proto.UserSearchRequestSchema, body);
          if (input.query !== "Owned generated fixture 2026")
            throw new Error("rejected");
          send(
            proto.SearchResponseSchema,
            create(proto.SearchResponseSchema, {
              query: input.query,
              results: [
                {
                  id: "owned-live-fixture-release",
                  title: "Owned generated fixture",
                  indexer: "Generated fixture",
                  size: BigInt(bytes),
                  seeders: 0n,
                  link: sourceUrl,
                },
              ],
            }),
          );
          return;
        }
        case "/chill.v4.UserService/GetFolder":
          calls.getFolder++;
          send(
            proto.GetFolderResponseSchema,
            await run(
              rpc.call((options) =>
                rpc.client.getFolder(
                  fromJsonString(proto.GetFolderRequestSchema, body),
                  options,
                ),
              ),
            ),
          );
          return;
        case "/chill.v4.UserService/AddTransfer": {
          const input = fromJsonString(proto.AddTransferRequestSchema, body);
          if (acquisitionClaimed || input.url !== sourceUrl)
            throw new Error("rejected");
          acquisitionClaimed = true;
          const settings = await run(
            rpc.call((options) => rpc.client.getUserSettings({}, options)),
          );
          if (settings.download?.folderId !== destination)
            throw new Error("destination_changed");
          calls.addTransfer++;
          const added = await run(
            rpc.call((options) => rpc.client.addTransfer(input, options)),
          );
          if (added.transfer) {
            transferIds.push(added.transfer.id);
            await observeTransfer(added.transfer);
          }
          send(proto.AddTransferResponseSchema, added);
          return;
        }
        case "/chill.v4.UserService/GetTransfer":
          calls.getTransfer++;
          send(
            proto.GetTransferResponseSchema,
            await run(
              rpc.call((options) =>
                rpc.client.getTransfer(
                  fromJsonString(proto.GetTransferRequestSchema, body),
                  options,
                ),
              ),
            ),
          );
          return;
        case "/chill.v4.UserService/ResolvePlayback":
          calls.resolvePlayback++;
          send(
            proto.ResolvePlaybackResponseSchema,
            await run(
              rpc.call((options) =>
                rpc.client.resolvePlayback(
                  fromJsonString(proto.ResolvePlaybackRequestSchema, body),
                  options,
                ),
              ),
            ),
          );
          return;
        default:
          throw new Error("rejected");
      }
    })().catch(() => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          '{"code":"unavailable","message":"Probe RPC unavailable"}',
        );
      }
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("listener_failed");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    calls,
    transferIds,
    close: async () => {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export const runHostedAcquisition = Effect.fn("live.runHostedAcquisition")(
  function* (options: { approvedExtra?: boolean } = {}) {
    const stamp = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
    const artifact = `artifacts/live-hosted-${stamp}`;
    const attempt = createLiveAttempt();
    const checkpoint = writeRecoveryJournal(
      attempt,
      `.cache/live/recovery/hosted-${stamp}.json`,
    );
    let stage = "preflight";
    const proof: Record<string, unknown> = {
      discovery: "generated-owned-fixture",
      acquisition: "production-engine-putio",
      createdResourcesOnly: true,
      submitted: false,
      streamListingReadOnly: false,
      headReadOnly: false,
      selection: "stremio-media-get",
      statusReadOnly: false,
      restartedStatusReadOnly: false,
      completedFileResolved: false,
      playbackResolved: false,
      decodedPlayback: false,
      localCleanup: false,
    };
    const privateContext: Record<string, unknown> = {};
    const contextPath = `.cache/live/recovery/hosted-${stamp}-context.json`;
    const persistContext = async () => {
      await mkdir(".cache/live/recovery", { recursive: true, mode: 0o700 });
      const temporary = `${contextPath}.tmp`;
      const file = await open(temporary, "w", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(privateContext, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, contextPath);
      const directory = await open(".cache/live/recovery", "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    const observeTransfer = async (transfer: proto.Transfer) => {
      privateContext.latestTransfer = {
        id: String(transfer.id),
        fileId:
          transfer.fileId === undefined ? undefined : String(transfer.fileId),
        saveParentId:
          transfer.saveParentId === undefined
            ? undefined
            : String(transfer.saveParentId),
        isFinished: transfer.isFinished,
      };
      proof.transferObservation = {
        fileIdPresent: transfer.fileId !== undefined,
        destinationPresent: transfer.saveParentId !== undefined,
        finished: transfer.isFinished,
        providerErrorPresent: Boolean(transfer.errorMessage),
      };
      await persistContext();
    };
    let prepareTransferCleanup: Effect.Effect<void, unknown> = Effect.void;
    const sanitizeFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          const error = Cause.findErrorOption(cause);
          proof.failureStage =
            Option.isSome(error) && error.value instanceof HostedProbeFailure
              ? error.value.stage
              : stage;
          if (Option.isSome(error) && error.value instanceof EngineError)
            proof.failureCode = error.value.code;
          return Effect.fail(
            new HostedProbeFailure({ stage, code: "hosted_probe_failed" }),
          );
        }),
      );
    const work = Effect.gen(function* () {
      yield* validateProvenance();
      const ledgerDirectory = yield* Effect.tryPromise(() =>
        registeredLiveRunner(),
      );
      const account = yield* accountInfo();
      if (
        !process.env[liveVersions.usernameEnv] ||
        account.username !== process.env[liveVersions.usernameEnv]?.trim()
      )
        return yield* new HostedProbeFailure({
          stage: "account",
          code: "hosted_probe_failed",
        });
      const chillToken = yield* Effect.tryPromise((signal) =>
        authorizeChill({ signal }),
      );
      const rpc = yield* createEngineRpc({
        baseUrl: "https://api.chill.institute/v4",
        token: chillToken,
      });
      const profile = yield* rpc.call((options) =>
        rpc.client.getUserProfile({}, options),
      );
      if (profile.username !== account.username)
        return yield* new HostedProbeFailure({
          stage: "account-match",
          code: "hosted_probe_failed",
        });
      const settings = yield* rpc.call((options) =>
        rpc.client.getUserSettings({}, options),
      );
      const destination = settings.download?.folderId;
      if (destination === undefined)
        return yield* new HostedProbeFailure({
          stage: "configured-destination",
          code: "hosted_probe_failed",
        });
      const baseline = yield* rpc.call((options) =>
        rpc.client.getFolder({ id: destination }, options),
      );
      if (baseline.parent?.id !== destination || baseline.files.length > 5000)
        return yield* new HostedProbeFailure({
          stage: "destination",
          code: "hosted_probe_failed",
        });
      const previousIds = new Set(baseline.files.map((file) => file.id));
      const source = yield* ensureLiveSource();
      if (source.bytes > 16 * 1024 * 1024)
        return yield* new HostedProbeFailure({
          stage: "fixture-size",
          code: "hosted_probe_failed",
        });
      privateContext.destination = String(destination);
      privateContext.baselineFileIds = [...previousIds].map(String);
      privateContext.source = {
        name: liveUploadName(stamp),
        bytes: source.bytes,
        sha256: source.sha256,
      };
      yield* Effect.tryPromise(persistContext);
      let copyOutcomeKnown = false;
      const trackCopy = Effect.fn("HostedProof.trackCopy")(function* (
        transfer: proto.Transfer,
      ) {
        yield* Effect.tryPromise(() => observeTransfer(transfer));
        if (
          !transfer.fileId ||
          transfer.saveParentId !== destination ||
          transfer.fileId > BigInt(Number.MAX_SAFE_INTEGER)
        )
          return;
        const listing = yield* rpc.call((options) =>
          rpc.client.getFolder({ id: destination }, options),
        );
        if (!listing.files.some((file) => file.id === transfer.fileId)) return;
        copyOutcomeKnown = true;
        if (!previousIds.has(transfer.fileId)) {
          const fileId = Number(transfer.fileId);
          if (!attempt.files.includes(fileId)) {
            attempt.files.push(fileId);
            yield* checkpoint;
          }
        }
      });
      prepareTransferCleanup = Effect.gen(function* () {
        if (attempt.transfers.length === 0 || copyOutcomeKnown) return;
        for (const id of attempt.transfers) {
          yield* Effect.exit(
            Effect.gen(function* () {
              const latest = yield* rpc.call((options) =>
                rpc.client.getTransfer({ id: BigInt(id) }, options),
              );
              if (latest.transfer) yield* trackCopy(latest.transfer);
            }),
          );
        }
        if (!copyOutcomeKnown) {
          attempt.pending.push({
            sequence: attempt.nextSequence++,
            kind: "file",
          });
          yield* checkpoint;
        }
      });
      const bytes = source.bytes * 2;
      if (options.approvedExtra)
        yield* Effect.tryPromise(() =>
          extendForOneAttempt(
            ledgerDirectory,
            bytes,
            `Owner-authorized single hosted fixture acquisition ${stamp}: 3 creations and ${bytes} bytes`,
          ),
        );
      yield* Effect.tryPromise((signal) =>
        reserve(ledgerDirectory, 3, bytes, undefined, {
          signal,
        }),
      );
      proof.reservation = { creations: 3, bytes };
      stage = "owned-source";
      const folder = yield* trackAcquisition(
        attempt,
        "file",
        createFolder(liveFolderName(stamp)),
        checkpoint,
      );
      const uploaded = yield* trackAcquisition(
        attempt,
        "file",
        uploadFile(source.path, liveUploadName(stamp), folder.id),
        checkpoint,
      );
      const sourceUrl = yield* downloadUrl(uploaded.id);
      stage = "hosted-services";
      let hosted: Awaited<ReturnType<typeof startHostedAdapter>> | undefined;
      let proxy:
        | Awaited<ReturnType<typeof startFixtureDiscoveryProxy>>
        | undefined;
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.tryPromise(async () => {
          let failed = false;
          try {
            await hosted?.close();
          } catch {
            failed = true;
          }
          try {
            await proxy?.close();
          } catch {
            failed = true;
          }
          proof.localCleanup = !failed;
        }),
      );
      // Production Engine verifies issued credentials; this local pair only
      // proves the adapter's credential-bearing acquisition and playback flow.
      const credential = `v4.local.${randomBytes(300).toString("base64url")}`;
      proxy = yield* Effect.tryPromise(() =>
        startFixtureDiscoveryProxy(
          chillToken,
          credential,
          sourceUrl,
          source.bytes,
          destination,
          observeTransfer,
        ),
      );
      const engineBaseUrl = proxy.origin;
      const reopen = async () => {
        const port = hosted ? Number(new URL(hosted.origin).port) : undefined;
        await hosted?.close();
        hosted = await startHostedAdapter({
          engineBaseUrl,
          webOrigin: "http://127.0.0.1:3000",
          port,
        });
        return hosted.origin;
      };
      let origin = yield* Effect.tryPromise(reopen);
      const request = Effect.fn("HostedProof.request")(function* (
        path: string,
      ) {
        const response = yield* Effect.tryPromise((signal) =>
          fetch(`${origin}${path}`, { signal, redirect: "error" }),
        );
        if (!response.ok)
          return yield* new HostedProbeFailure({
            stage,
            code: "hosted_probe_failed",
          });
        return yield* Effect.tryPromise(() => response.json());
      });
      const target = discoveryTargetId({
        kind: "movie",
        id: "owned-live-fixture",
      });
      const base = `/s/${credential}`;
      stage = "discovery-stream-listing";
      const selectionStreams = yield* Schema.decodeUnknownEffect(
        StreamResponse,
      )(
        yield* request(
          `${base}/stream/movie/${encodeURIComponent(target)}.json`,
        ),
      );
      const selectedStream = selectionStreams.streams[0];
      if (
        selectionStreams.streams.length !== 1 ||
        !selectedStream ||
        proxy.calls.addTransfer !== 0
      )
        return yield* new HostedProbeFailure({
          stage,
          code: "hosted_probe_failed",
        });
      const selectedUrl = new URL(selectedStream.url);
      if (
        selectedUrl.origin !== origin ||
        selectedUrl.search ||
        selectedUrl.hash
      )
        return yield* new HostedProbeFailure({
          stage,
          code: "hosted_probe_failed",
        });
      const selectionPath = selectedUrl.pathname;
      proof.streamListingReadOnly = true;
      stage = "selection-head";
      yield* Effect.tryPromise((signal) =>
        requestSelectedMedia(origin, selectionPath, "HEAD", signal),
      );
      if (proxy.calls.addTransfer !== 0)
        return yield* new HostedProbeFailure({
          stage,
          code: "hosted_probe_failed",
        });
      proof.headReadOnly = true;
      stage = "media-selection";
      const selectionProxy = proxy;
      const acquired = yield* trackAcquisition(
        attempt,
        "transfer",
        Effect.gen(function* () {
          yield* Effect.tryPromise((signal) =>
            requestSelectedMedia(origin, selectionPath, "GET", signal),
          );
          const transferId = selectionProxy.transferIds[0];
          if (
            selectionProxy.transferIds.length !== 1 ||
            transferId === undefined ||
            transferId > BigInt(Number.MAX_SAFE_INTEGER)
          )
            return yield* new HostedProbeFailure({
              stage,
              code: "hosted_probe_failed",
            });
          return { id: Number(transferId) };
        }),
        checkpoint,
      );
      proof.submitted = true;
      const statusPath = `${base}/status/${acquired.id}.m3u8`;
      const readStatus = Effect.fn("HostedProof.readStatus")(function* () {
        const response = yield* Effect.tryPromise((signal) =>
          fetch(`${origin}${statusPath}`, {
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
          }),
        );
        yield* Effect.promise(async () => response.body?.cancel());
        return {
          status: response.status,
          location: response.headers.get("location"),
        };
      });
      stage = "status-read";
      yield* readStatus();
      if (Number(proxy.calls.addTransfer) !== 1)
        return yield* new HostedProbeFailure({
          stage,
          code: "hosted_probe_failed",
        });
      proof.statusReadOnly = true;
      origin = yield* Effect.tryPromise(reopen);
      stage = "restarted-status-read";
      yield* readStatus();
      if (Number(proxy.calls.addTransfer) !== 1)
        return yield* new HostedProbeFailure({
          stage,
          code: "hosted_probe_failed",
        });
      proof.restartedStatusReadOnly = true;
      stage = "completed-file";
      const fileId = yield* Effect.gen(function* () {
        for (let round = 0; round < 120; round++) {
          const current = yield* rpc.call((options) =>
            rpc.client.getTransfer({ id: BigInt(acquired.id) }, options),
          );
          const transfer = current.transfer;
          if (transfer) yield* trackCopy(transfer);
          if (transfer?.errorMessage)
            return yield* new HostedProbeFailure({
              stage: "transfer-failed",
              code: "hosted_probe_failed",
            });
          if (transfer?.isFinished) {
            if (!copyOutcomeKnown || !transfer.fileId)
              return yield* new HostedProbeFailure({
                stage: "cleanup-identity",
                code: "hosted_probe_failed",
              });
            return transfer.fileId;
          }
          yield* Effect.sleep("5 seconds");
        }
        return undefined;
      }).pipe(Effect.timeout("10 minutes"));
      if (fileId === undefined)
        return yield* new HostedProbeFailure({
          stage,
          code: "hosted_probe_failed",
        });
      const completed = yield* readStatus();
      if (completed.status !== 302 || Number(proxy.calls.addTransfer) !== 1)
        return yield* new HostedProbeFailure({
          stage,
          code: "hosted_probe_failed",
        });
      proof.completedFileResolved = true;
      stage = "playback-resolution";
      const stremioId = `chill:file:${fileId}`;
      const manifestUrl = `${origin}${base}/manifest.json`;
      const streamPath = `${base}/stream/movie/${encodeURIComponent(stremioId)}.json`;
      const playback = yield* Schema.decodeUnknownEffect(StreamResponse)(
        yield* request(streamPath),
      );
      if (
        playback.streams.length !== 1 ||
        !playback.streams[0]?.url.startsWith("https:")
      )
        return yield* new HostedProbeFailure({
          stage,
          code: "hosted_probe_failed",
        });
      proof.playbackResolved = true;
      stage = "decoded-playback";
      const browserCleanup = {
        browserClosed: false,
        contextClosed: false,
        webClosed: false,
        engineBearerAbsent: true,
      };
      proof.browserCleanup = browserCleanup;
      proof.playback = yield* proveHostedBrowserPlayback({
        manifestUrl,
        stremioId,
        streamPath,
        mediaUrls: playback.streams.map((stream) => stream.url),
        token: chillToken,
        cleanup: browserCleanup,
        onStage: (value) => {
          stage = `browser-${value}`;
        },
        onDecoded: (value) => {
          proof.decodedFrames = value;
        },
        onFrames: (value) => {
          proof.intactFrames = value;
        },
      });
      if (!Object.values(browserCleanup).every(Boolean))
        return yield* new HostedProbeFailure({
          stage: "browser-cleanup",
          code: "hosted_probe_failed",
        });
      proof.decodedPlayback = true;
      proof.rpcCounts = proxy.calls;
    }).pipe(Effect.scoped, Effect.timeout("12 minutes"));
    yield* withLiveLifecycle(attempt, sanitizeFailure(work), {
      cancelTransfers: (ids) =>
        prepareTransferCleanup.pipe(Effect.andThen(cancelTransfers(ids))),
      deleteFiles,
      checkpoint,
      publish: (outcome) =>
        Effect.tryPromise(async () => {
          await mkdir(artifact, { recursive: true, mode: 0o700 });
          if (proof.localCleanup !== true) outcome.status = "failed";
          const passed = outcome.status === "passed";
          await writeFile(
            `${artifact}/results.json`,
            `${JSON.stringify({ status: passed ? "passed" : "failed", proof, primary: outcome.primary, cleanup: outcome.cleanup }, null, 2)}\n`,
            { mode: 0o600 },
          );
          console.log(`${artifact}/results.json`);
        }),
    });
    return attempt.outcome;
  },
);

if (import.meta.main) {
  const args = process.argv.slice(2);
  const program = args.some((arg) => arg !== "--approved-extra")
    ? Effect.fail(
        new HostedProbeFailure({
          stage: "arguments",
          code: "hosted_probe_failed",
        }),
      )
    : runHostedAcquisition({
        approvedExtra: args.includes("--approved-extra"),
      }).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome?.status !== "passed") process.exitCode = 1;
          }),
        ),
      );
  NodeRuntime.runMain(
    program.pipe(
      Effect.provide(NodeServices.layer),
      Effect.catchCause(() =>
        Effect.sync(() => {
          process.exitCode = 1;
          console.log('{"status":"failed","code":"hosted_probe_failed"}');
        }),
      ),
    ),
    { disableErrorReporting: true },
  );
}

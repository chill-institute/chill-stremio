import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import { test, vi } from "vite-plus/test";
import { liveVersions } from "../harness/live/versions.ts";
import { AllowanceFailure, utcDay } from "../harness/live/allowance.ts";

const state = vi.hoisted(() => ({
  directory: "",
  movie: "",
  captions: "",
  mutations: 0,
}));

vi.mock("../harness/live/runner.ts", async (original) => ({
  ...(await original<typeof import("../harness/live/runner.ts")>()),
  liveRunnerDirectory: async () => state.directory,
}));

vi.mock("../harness/live/source.ts", async (original) => {
  const { Effect } = await import("effect");
  return {
    ...(await original<typeof import("../harness/live/source.ts")>()),
    ensureLiveSource: () =>
      Effect.succeed({
        path: state.movie,
        captions: state.captions,
        file: "movie.mp4",
        bytes: 13,
        captionBytes: 5,
        sha256: "fixture",
      }),
  };
});

vi.mock("../harness/live/playback.ts", async (original) => {
  const { Effect } = await import("effect");
  return {
    ...(await original<typeof import("../harness/live/playback.ts")>()),
    muxFixtureCaptions: () =>
      Effect.fail(new Error("fixture uses copy fallback")),
  };
});

vi.mock("../harness/live/putio.ts", async (original) => {
  const { Effect } = await import("effect");
  return {
    ...(await original<typeof import("../harness/live/putio.ts")>()),
    accountInfo: () =>
      Effect.succeed({ username: "fixture", account_status: "active" }),
    createFolder: () =>
      Effect.sync(() => {
        state.mutations++;
        throw new Error("must not mutate when reservation fails");
      }),
  };
});

const { runLive } = await import("../harness/live/probe.ts");

test("the real live orchestration cannot create provider resources after allowance rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-reservation-"));
  const previous = process.env[liveVersions.usernameEnv];
  process.env[liveVersions.usernameEnv] = "fixture";
  state.directory = root;
  state.movie = join(root, "fixture.mp4");
  state.captions = join(root, "fixture.vtt");
  state.mutations = 0;
  try {
    await writeFile(state.movie, Buffer.alloc(13));
    await writeFile(state.captions, Buffer.alloc(5));
    await writeFile(
      join(root, "allowance.json"),
      JSON.stringify({
        day: utcDay(),
        reservedTransfers: 10,
        reservedBytes: liveVersions.byteLimit,
      }),
    );
    await assert.rejects(
      Effect.runPromise(
        Effect.scoped(runLive(join(root, "attempt"))).pipe(
          Effect.provide(NodeServices.layer),
        ),
      ),
      (error: unknown) =>
        error instanceof Cause.UnknownError &&
        error.cause instanceof AllowanceFailure,
    );
    assert.equal(state.mutations, 0);
  } finally {
    if (previous === undefined) delete process.env[liveVersions.usernameEnv];
    else process.env[liveVersions.usernameEnv] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

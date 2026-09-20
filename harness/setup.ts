import { mkdir, access, writeFile, rm, rename } from "node:fs/promises";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { command } from "./process.ts";
import { versions } from "./versions.ts";
import { generateMedia } from "./media.ts";
import { collectProvenance } from "./provenance.ts";

const webDir = `${process.cwd()}/.cache/stremio-web`;
class FixtureCheckoutMismatch extends Schema.TaggedError<FixtureCheckoutMismatch>()(
  "FixtureCheckoutMismatch",
  {
    expected: Schema.String,
    actual: Schema.String,
  },
) {}

NodeRuntime.runMain(
  Effect.gen(function* () {
    yield* Effect.promise(() => mkdir(".cache", { recursive: true }));
    yield* Effect.promise(() => rm(".cache/setup.json", { force: true }));
    yield* command("ffmpeg", ["-version"]);
    yield* command(process.execPath, ["scripts/status-media.ts"]);
    const exists = yield* Effect.promise(() =>
      access(`${webDir}/.git`).then(
        () => true,
        () => false,
      ),
    );
    if (!exists) {
      yield* command("git", ["init", webDir]);
      yield* command(
        "git",
        [
          "fetch",
          "--depth=1",
          "https://github.com/Stremio/stremio-web.git",
          versions.web,
        ],
        webDir,
      );
      yield* command("git", ["checkout", "--detach", "FETCH_HEAD"], webDir);
    }
    yield* command("git", ["diff", "HEAD", "--exit-code"], webDir);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const actual = (yield* spawner
      .string(
        ChildProcess.make("git", ["rev-parse", "HEAD"], {
          cwd: webDir,
          stdin: "ignore",
          stderr: "inherit",
        }),
      )
      .pipe(Effect.timeout("30 seconds"))).trim();
    if (actual !== versions.web)
      return yield* new FixtureCheckoutMismatch({
        expected: versions.web,
        actual,
      });
    yield* command(
      "pnpm",
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      webDir,
    );
    yield* command("pnpm", ["build"], webDir);
    yield* command("pnpm", ["exec", "playwright", "install", "chromium"]);
    yield* Effect.tryPromise((signal) => generateMedia(".cache/media", signal));
    const provenance = yield* collectProvenance();
    yield* Effect.promise(async () => {
      await writeFile(
        ".cache/setup.json.tmp",
        JSON.stringify(provenance, null, 2),
      );
      await rename(".cache/setup.json.tmp", ".cache/setup.json");
    });
    yield* Effect.log("Fixture setup ready");
  }).pipe(Effect.timeout("25 minutes"), Effect.provide(NodeServices.layer)),
);

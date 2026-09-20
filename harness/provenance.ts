import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { versions } from "./versions.ts";

const digest = Schema.Struct({ file: Schema.String, sha256: Schema.String });
const provenanceSchema = Schema.Struct({
  versions: Schema.Literal(JSON.stringify(versions)),
  revision: Schema.Literal(versions.web),
  ffmpeg: Schema.String,
  web: Schema.Array(digest),
  media: Schema.Array(digest),
});
export type Provenance = typeof provenanceSchema.Type;

export class FixtureProvenanceFailure extends Schema.TaggedError<FixtureProvenanceFailure>()(
  "FixtureProvenanceFailure",
  {
    message: Schema.String,
  },
) {}

async function manifest(
  root: string,
  directory = "",
): Promise<{ file: string; sha256: string }[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files: { file: string; sha256: string }[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await manifest(root, file)));
    else if (entry.isFile())
      files.push({
        file,
        sha256: createHash("sha256")
          .update(await readFile(join(root, file)))
          .digest("hex"),
      });
    else
      throw new Error("Fixture provenance refuses symlinks and special files");
  }
  return files;
}

export const collectProvenance = Effect.fn("harness.collectProvenance")(
  function* () {
    const require = createRequire(import.meta.url);
    for (const [name, expected] of Object.entries({
      effect: versions.effect,
      "@effect/platform-node": versions.effect,
      "@playwright/test": versions.playwright,
      "stremio-addon-sdk": versions.sdk,
      "stremio-addon-client": versions.client,
      "stremio-addon-linter": versions.linter,
    })) {
      const raw = yield* Effect.tryPromise(() =>
        readFile(require.resolve(`${name}/package.json`), "utf8"),
      );
      const actual = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
      )(raw);
      if (actual.version !== expected)
        return yield* new FixtureProvenanceFailure({
          message: `Installed ${name} version differs from harness pin`,
        });
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const revision = (yield* spawner.string(
      ChildProcess.make("git", ["rev-parse", "HEAD"], {
        cwd: ".cache/stremio-web",
        stdin: "ignore",
      }),
    )).trim();
    const changed = (yield* spawner.string(
      ChildProcess.make(
        "git",
        ["status", "--porcelain", "--untracked-files=no"],
        {
          cwd: ".cache/stremio-web",
          stdin: "ignore",
        },
      ),
    )).trim();
    if (revision !== versions.web || changed)
      return yield* new FixtureProvenanceFailure({
        message:
          "Pinned Web checkout differs; rerun setup from a clean pinned checkout",
      });
    const ffmpeg =
      (yield* spawner.string(
        ChildProcess.make("ffmpeg", ["-version"], { stdin: "ignore" }),
      )).split("\n")[0] ?? "";
    const web = yield* Effect.tryPromise(() =>
      manifest(".cache/stremio-web/build"),
    );
    const media = yield* Effect.tryPromise(() => manifest(".cache/media"));
    const index = yield* Effect.tryPromise(() =>
      readFile(".cache/stremio-web/build/index.html", "utf8"),
    );
    const mediaNames = [
      "english.vtt",
      "episode1.mp4",
      "episode2.mp4",
      "movie.mp4",
      "spanish.vtt",
    ];
    if (
      !index.includes(versions.web) ||
      JSON.stringify(media.map((file) => file.file).sort()) !==
        JSON.stringify(mediaNames)
    ) {
      return yield* new FixtureProvenanceFailure({
        message: "Fixture media or built Web manifest incomplete; rerun setup",
      });
    }
    return yield* Schema.decodeUnknownEffect(provenanceSchema)({
      versions: JSON.stringify(versions),
      revision,
      ffmpeg,
      web,
      media,
    });
  },
  Effect.timeout("1 minute"),
);

export const validateProvenance = Effect.fn("harness.validateProvenance")(
  function* () {
    const raw = yield* Effect.tryPromise(() =>
      readFile(".cache/setup.json", "utf8"),
    );
    const expected = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(provenanceSchema),
    )(raw);
    const actual = yield* collectProvenance();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      return yield* new FixtureProvenanceFailure({
        message: "Fixture setup hashes or encoder version changed; rerun setup",
      });
    }
    return actual;
  },
);

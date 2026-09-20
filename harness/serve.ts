import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { startFixture } from "./fixture.ts";

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* startFixture();
      console.log(
        JSON.stringify({
          manifest: `${fixture.origin}/manifest.json`,
          cleanup: "Ctrl-C or SIGTERM",
        }),
      );
      yield* Effect.never;
    }),
  ),
);

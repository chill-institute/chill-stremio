import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { runAuthenticatedAdapter } from "./adapter.ts";
import { authorizeChill } from "./auth.ts";

const program = Effect.gen(function* () {
  const account = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      stremioEmail: Schema.NonEmptyString,
      stremioPassword: Schema.NonEmptyString,
    }),
  )({
    stremioEmail: process.env.STREMIO_EMAIL,
    stremioPassword: process.env.STREMIO_PASSWORD,
  });
  const chillToken = yield* Effect.tryPromise((signal) =>
    authorizeChill({ signal }),
  );
  const result = yield* runAuthenticatedAdapter({ ...account, chillToken });
  if (result.status !== "passed") process.exitCode = 1;
}).pipe(
  Effect.catchCause(() =>
    Effect.sync(() => {
      process.exitCode = 1;
      console.log(
        JSON.stringify({
          status: "failed",
          code: "authenticated_probe_failed",
        }),
      );
    }),
  ),
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(program, { disableErrorReporting: true });

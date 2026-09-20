import { Effect, Schema } from "effect";
import { ChildProcess } from "effect/unstable/process";

export class CommandFailure extends Schema.TaggedError<CommandFailure>()(
  "CommandFailure",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {}

export const command = Effect.fn("harness.command")(
  function* (executable: string, args: string[], cwd = process.cwd()) {
    const child = yield* ChildProcess.make(executable, args, {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
    });
    const code = yield* child.exitCode;
    if (code !== 0)
      return yield* new CommandFailure({ command: executable, exitCode: code });
  },
  Effect.scoped,
  Effect.timeout("15 minutes"),
);

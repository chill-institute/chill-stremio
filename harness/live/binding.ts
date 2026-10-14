import { Effect } from "effect";
import type { createEngineRpc } from "../../src/engine.ts";

/** Whether an add-on credential and the put.io token list the same account root. */
export const sameAccountRoot = Effect.fn("live.sameAccountRoot")(function* (
  rpc: Effect.Success<ReturnType<typeof createEngineRpc>>,
  listFolderIds: (id: number) => Effect.Effect<readonly number[], unknown>,
) {
  const [engineRoot, providerRoot] = yield* Effect.all(
    [
      rpc.call((call) => rpc.client.getFolder({ id: 0n }, call)),
      listFolderIds(0),
    ],
    { concurrency: 2 },
  );
  const engineIds = engineRoot.files.map((file) => String(file.id)).sort();
  const providerIds = providerRoot.map(String).sort();
  return providerIds.length > 0 && engineIds.join() === providerIds.join();
});

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Predicate, Schema } from "effect";

const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  transportUrl: Schema.String,
  baselineHashes: Schema.Array(Schema.String),
  state: Schema.Literals(["prepared", "uncertain", "removal-verified"]),
});
const Descriptor = Schema.Struct({ transportUrl: Schema.String });

export function descriptorHash(descriptor: unknown) {
  const json = Schema.decodeUnknownSync(Schema.Json)(descriptor);
  return createHash("sha256")
    .update(
      JSON.stringify(json, (_key, value: unknown) =>
        Predicate.isObject(value) && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            )
          : value,
      ),
    )
    .digest("hex");
}

export interface AndroidRecoveryJournal {
  id: string;
  path: string;
}
const syncDirectory = async (path: string) => {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};
const exited = Schema.is(Schema.Struct({ code: Schema.Literal("ESRCH") }));
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !exited(error);
  }
};
// Each writer creates its own pending file before looking for others, so of
// two overlapping writers at least one sees the other and fails. A pending
// file whose process has exited is a crashed write and is discarded.
const save = async (path: string, receipt: typeof Receipt.Type) => {
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  const own = `${prefix}${process.pid}.${randomUUID()}.pending`;
  const pending = join(directory, own);
  try {
    const output = await open(pending, "wx", 0o600);
    try {
      for (const entry of await readdir(directory)) {
        const owner = entry.startsWith(prefix)
          ? /^(\d+)\.[0-9a-f-]+\.pending$/.exec(entry.slice(prefix.length))
          : null;
        if (!owner?.[1] || entry === own) continue;
        if (running(Number(owner[1])))
          throw new Error("Another process is writing this recovery receipt");
        await rm(join(directory, entry), { force: true });
      }
      await output.writeFile(JSON.stringify(receipt, null, 2));
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
  await syncDirectory(directory);
};
export async function createAndroidRecoveryJournal(
  transportUrl: string,
  baseline: readonly unknown[],
  root = ".cache/native/android/recovery",
): Promise<AndroidRecoveryJournal> {
  const url = new URL(transportUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/manifest.json" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Recovery journal requires an owned loopback fixture URL");
  const baselineHashes = baseline.map(descriptorHash);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "attempt-"));
  const journal = {
    id: basename(directory),
    path: join(directory, "receipt.json"),
  };
  await save(journal.path, {
    version: 1,
    transportUrl,
    baselineHashes,
    state: "prepared",
  });
  await syncDirectory(root);
  await syncDirectory(dirname(root));
  return journal;
}
export async function reconcileAndroidRecoveryJournal(
  journal: AndroidRecoveryJournal,
  after?: readonly unknown[],
) {
  const receipt = Schema.decodeUnknownSync(Schema.fromJsonString(Receipt))(
    await readFile(journal.path, "utf8"),
  );
  const hashes = after?.map(descriptorHash);
  const removed =
    after !== undefined &&
    hashes !== undefined &&
    after.every(
      (item) =>
        Schema.decodeUnknownSync(Descriptor)(item).transportUrl !==
        receipt.transportUrl,
    ) &&
    receipt.baselineHashes.every((hash) => hashes.includes(hash));
  await save(journal.path, {
    ...receipt,
    state: removed ? "removal-verified" : "uncertain",
  });
  if (after && !removed)
    throw new Error(
      "Exact recovery and baseline preservation were not verified",
    );
}

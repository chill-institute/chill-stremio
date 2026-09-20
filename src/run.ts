import { mkdir, writeFile, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { engineLayer } from "./engine.ts";
import { startAdapter } from "./server.ts";

const Config = Schema.Struct({
  CHILL_TOKEN: Schema.String.check(Schema.isMinLength(1)),
  CHILL_FOLDER_ID: Schema.String.check(
    Schema.isPattern(/^(0|[1-9][0-9]{0,18})$/),
  ),
  CHILL_ADAPTER_PORT: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9]{1,5}$/)),
  ),
});

async function main() {
  const config = Schema.decodeUnknownSync(Config)(process.env);
  const port = Number(config.CHILL_ADAPTER_PORT ?? "7000");
  if (port !== 0 && (port < 1024 || port > 65535))
    throw new Error("Invalid adapter port");
  const directory = resolve(".cache/adapter");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new Error(
      "Adapter state directory must be private and owned by this user",
    );
  const receipt = join(directory, "install.json");
  const adapter = await startAdapter({
    layer: engineLayer({
      baseUrl: "https://api.chill.institute/v4",
      token: config.CHILL_TOKEN,
    }),
    folderId: BigInt(config.CHILL_FOLDER_ID),
    port,
  });
  try {
    await writeFile(
      receipt,
      JSON.stringify({ manifestUrl: adapter.manifestUrl }, null, 2),
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    await adapter.close();
    throw new Error(
      "Installation receipt already exists; remove it only after its adapter has stopped",
    );
  }
  console.log(
    "Adapter running. Private installation URL: .cache/adapter/install.json",
  );
  try {
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
  } finally {
    await adapter.close();
    await rm(receipt);
  }
}

main().catch(() => {
  console.error(
    "Adapter failed. Check the private runtime configuration and installation receipt.",
  );
  process.exitCode = 1;
});

import { resolve } from "node:path";
import { Schema } from "effect";
import { startHostedAdapter } from "./hosted.ts";
import { InstallationStore } from "./installations.ts";

const Configuration = Schema.Struct({
  CHILL_INSTALLATION_KEY_HEX: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{64}$/),
  ),
  CHILL_PUBLIC_ORIGIN: Schema.NonEmptyString,
  CHILL_WEB_ORIGIN: Schema.optional(Schema.NonEmptyString),
  CHILL_ENGINE_BASE_URL: Schema.optional(Schema.NonEmptyString),
  CHILL_STATE_DIRECTORY: Schema.optional(Schema.NonEmptyString),
  CHILL_LISTEN_HOST: Schema.optional(
    Schema.Literals(["127.0.0.1", "0.0.0.0", "::"]),
  ),
  CHILL_LISTEN_PORT: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9]{1,5}$/)),
  ),
});
async function main() {
  process.umask(0o077);
  const config = Schema.decodeUnknownSync(Configuration)(process.env);
  const port = Number(config.CHILL_LISTEN_PORT ?? "7000");
  if (port < 1024 || port > 65535) throw new Error("Invalid port");
  const key = Buffer.from(config.CHILL_INSTALLATION_KEY_HEX, "hex");
  let store: InstallationStore;
  try {
    store = await InstallationStore.open(
      resolve(
        config.CHILL_STATE_DIRECTORY ?? ".cache/hosted",
        "installations.sqlite",
      ),
      key,
    );
  } finally {
    key.fill(0);
  }
  try {
    const server = await startHostedAdapter({
      store,
      port,
      host: config.CHILL_LISTEN_HOST ?? "127.0.0.1",
      publicOrigin: config.CHILL_PUBLIC_ORIGIN,
      webOrigin: config.CHILL_WEB_ORIGIN ?? "https://chill.institute",
      engineBaseUrl:
        config.CHILL_ENGINE_BASE_URL ?? "https://api.chill.institute/v4",
    });
    console.log("Hosted adapter ready.");
    try {
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    } finally {
      await server.close();
    }
  } finally {
    store.close();
  }
}
main().catch(() => {
  console.error(
    "Hosted adapter failed. Check private runtime configuration and storage.",
  );
  process.exitCode = 1;
});

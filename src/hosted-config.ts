import { Schema } from "effect";

export function hostedAuthority(host: string) {
  return host.toLowerCase().replace(/:443$/, "").replace(/\.$/, "");
}

const Configuration = Schema.Struct({
  CHILL_PUBLIC_ORIGINS: Schema.optional(Schema.NonEmptyString),
  CHILL_PUBLIC_ORIGIN: Schema.optional(Schema.NonEmptyString),
  CHILL_WEB_ORIGIN: Schema.optional(Schema.NonEmptyString),
  CHILL_ENGINE_BASE_URL: Schema.optional(Schema.NonEmptyString),
  CHILL_LISTEN_HOST: Schema.optional(
    Schema.Literals(["127.0.0.1", "0.0.0.0", "::"]),
  ),
  CHILL_LISTEN_PORT: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9]{1,5}$/)),
  ),
});

function originPairs(config: typeof Configuration.Type) {
  if (!config.CHILL_PUBLIC_ORIGINS) {
    if (!config.CHILL_PUBLIC_ORIGIN) throw new Error("No public origin");
    return [
      {
        publicOrigin: config.CHILL_PUBLIC_ORIGIN,
        webOrigin: config.CHILL_WEB_ORIGIN ?? "https://chill.institute",
      },
    ];
  }
  const pairs = config.CHILL_PUBLIC_ORIGINS.split(",").map((entry) => {
    const [publicOrigin, webOrigin, ...rest] = entry.trim().split("=");
    if (!publicOrigin || !webOrigin || rest.length > 0)
      throw new Error("Invalid public origin pair");
    return { publicOrigin, webOrigin };
  });
  if (!config.CHILL_PUBLIC_ORIGIN) {
    if (config.CHILL_WEB_ORIGIN)
      throw new Error("Conflicting public origin configuration");
    return pairs;
  }
  const primary = pairs.find(
    ({ publicOrigin }) => publicOrigin === config.CHILL_PUBLIC_ORIGIN,
  );
  if (
    !primary ||
    (config.CHILL_WEB_ORIGIN && config.CHILL_WEB_ORIGIN !== primary.webOrigin)
  )
    throw new Error("Conflicting public origin configuration");
  return [primary, ...pairs.filter((pair) => pair !== primary)];
}

export function hostedConfiguration(env: Record<string, string | undefined>) {
  const config = Schema.decodeUnknownSync(Configuration)(env);
  const port = Number(config.CHILL_LISTEN_PORT ?? "7000");
  if (port < 1024 || port > 65535) throw new Error("Invalid port");
  const [primary, ...additionalOrigins] = originPairs(config);
  if (!primary) throw new Error("No public origin");
  return {
    port,
    host: config.CHILL_LISTEN_HOST ?? "127.0.0.1",
    publicOrigin: primary.publicOrigin,
    webOrigin: primary.webOrigin,
    additionalOrigins,
    engineBaseUrl:
      config.CHILL_ENGINE_BASE_URL ?? "https://api.chill.institute/v4",
  };
}

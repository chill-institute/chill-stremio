export function hostAuthority(host: string, protocol: string) {
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(host);
  if (!match) return undefined;
  const hostname = match[1]!.toLowerCase().replace(/\.$/, "");
  const port = match[2];
  const defaultPort =
    protocol === "https:" ? "443" : protocol === "http:" ? "80" : undefined;
  return hostname + (port && port !== defaultPort ? `:${port}` : "");
}

export function originIdentity(value: string) {
  const url = new URL(value);
  url.hostname = url.hostname.replace(/\.$/, "");
  return url.href;
}

export function configuredOrigin(pair: {
  publicOrigin: string;
  webOrigin: string;
}) {
  const url = new URL(pair.publicOrigin);
  return {
    origin: pair.publicOrigin,
    host: hostAuthority(url.host, url.protocol),
    protocol: url.protocol,
    webOrigin: pair.webOrigin,
  };
}

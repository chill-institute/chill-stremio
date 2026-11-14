export function hostAuthority(host: string, protocol: string) {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?)(?::([0-9]{1,5}))?$/.exec(host);
  if (!match) return undefined;
  const hostname = match[1]!.toLowerCase().replace(/\.$/, "");
  const port = match[2];
  const defaultPort =
    protocol === "https:" ? "443" : protocol === "http:" ? "80" : undefined;
  return hostname + (port && port !== defaultPort ? `:${port}` : "");
}

export function originIdentity(value: string) {
  if (!URL.canParse(value)) throw new Error("Invalid hosted origin");
  const url = new URL(value);
  url.hostname = url.hostname.replace(/\.$/, "");
  return url.href;
}

function listenerAuthority(url: URL) {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname.toLowerCase().replace(/\.$/, "")}:${port}`;
}

export function configuredOrigin(pair: {
  publicOrigin: string;
  webOrigin: string;
}) {
  const url = new URL(pair.publicOrigin);
  return {
    origin: pair.publicOrigin,
    host: hostAuthority(url.host, url.protocol),
    listener: listenerAuthority(url),
    protocol: url.protocol,
    webOrigin: pair.webOrigin,
  };
}

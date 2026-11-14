export type ProductionEndpoints = {
  domain: string;
  stremio: string;
  web: string;
  api: string;
  engine: string;
};

export type LiveEndpoints = Pick<
  ProductionEndpoints,
  "stremio" | "api" | "engine"
> &
  Partial<Pick<ProductionEndpoints, "domain" | "web">>;

type Probed = "stremio" | "api";

type Probe = {
  candidates?: readonly ProductionEndpoints[];
  reach?: (origin: string) => Promise<boolean>;
  warn?: (message: string) => void;
};

export const productionDomains = ["binge.institute", "chill.institute"];

export const productionEndpoints = (domain: string): ProductionEndpoints => ({
  domain,
  stremio: `https://stremio.${domain}`,
  web: `https://${domain}`,
  api: `https://api.${domain}`,
  engine: `https://api.${domain}/v4`,
});

export const isProductionStremioOrigin = (origin: string) =>
  productionDomains.some(
    (domain) => productionEndpoints(domain).stremio === origin,
  );

export async function reachable(origin: string) {
  try {
    const response = await fetch(origin, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export async function reachableProduction(
  roles: readonly Probed[] = ["stremio", "api"],
  probe: Probe = {},
) {
  const reach = probe.reach ?? reachable;
  const warn = probe.warn ?? console.warn;
  const unreachable: string[] = [];
  for (const candidate of probe.candidates ??
    productionDomains.map(productionEndpoints)) {
    const missing: string[] = [];
    for (const role of roles)
      if (!(await reach(candidate[role]))) missing.push(candidate[role]);
    if (missing.length === 0) {
      console.log(`production domain: ${candidate.domain}`);
      return candidate;
    }
    for (const origin of missing)
      warn(`warning: ${origin} is unreachable; trying the next domain`);
    unreachable.push(...missing);
  }
  throw new Error(`No production domain reachable: ${unreachable.join(", ")}`);
}

const originOf = (value: string) =>
  URL.canParse(value) ? new URL(value).origin : value;

const domainServing = (role: Probed, value: string | undefined) =>
  value === undefined
    ? undefined
    : productionDomains.find(
        (domain) => productionEndpoints(domain)[role] === originOf(value),
      );

export async function resolveLiveEndpoints(
  env: Record<string, string | undefined>,
  probe: Probe = {},
): Promise<LiveEndpoints> {
  const stremio = env.CHILL_PUBLIC_STREMIO_ORIGIN?.trim() || undefined;
  const engine =
    env.CHILL_ENGINE_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
  if (stremio && engine) {
    const domain =
      domainServing("stremio", stremio) ?? domainServing("api", engine);
    return {
      ...(domain ? { domain, web: productionEndpoints(domain).web } : {}),
      stremio: originOf(stremio),
      api: originOf(engine),
      engine,
    };
  }
  const pinned =
    domainServing("stremio", stremio) ?? domainServing("api", engine);
  const chosen = pinned
    ? productionEndpoints(pinned)
    : await reachableProduction(
        stremio ? ["api"] : engine ? ["stremio"] : undefined,
        probe,
      );
  return {
    domain: chosen.domain,
    web: chosen.web,
    stremio: stremio ? originOf(stremio) : chosen.stremio,
    api: engine ? originOf(engine) : chosen.api,
    engine: engine ?? chosen.engine,
  };
}

let shared: Promise<LiveEndpoints> | undefined;
let production: Promise<ProductionEndpoints> | undefined;

export const liveEndpoints = () =>
  (shared ??= resolveLiveEndpoints(process.env));

export const productionLiveEndpoints = () =>
  (production ??= liveEndpoints().then((endpoints) =>
    endpoints.domain
      ? productionEndpoints(endpoints.domain)
      : reachableProduction(),
  ));

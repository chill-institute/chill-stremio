import { classifyTvHierarchy } from "./android-ui.ts";
import { androidVersions } from "./android-versions.ts";

/** Pairing values must stay in memory and must never enter evidence. */
export function pairingChallenge(xml: string): string | undefined {
  if (!classifyTvHierarchy(xml, androidVersions.package).pairingChallenge)
    return;
  const values = [...xml.matchAll(/(?:text|content-desc)="([^"]*)"/g)].map(
    (entry) => entry[1] ?? "",
  );
  const links = values.flatMap((value) => {
    const match = value.match(
      /(?:https:\/\/)?link\.stremio\.com\/([A-Z0-9]{4})\b/i,
    );
    return match?.[1] ? [match[1].toUpperCase()] : [];
  });
  const codes = links.length
    ? links
    : values.filter(
        (value) =>
          /^[A-Z0-9]{4}$/.test(value) && !["HOME", "CODE"].includes(value),
      );
  const unique = [...new Set(codes)];
  return unique.length === 1 ? unique[0] : undefined;
}

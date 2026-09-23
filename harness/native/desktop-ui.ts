export type DesktopInstallStage = "addons" | "add-url" | "manifest";

/** Every confidently recognized word equal to `label` inside `bounds`. */
export function desktopTextMatches(
  tsv: string,
  label: string,
  bounds = { left: 0, top: 0, right: 1280, bottom: 720 },
) {
  return tsv.split("\n").flatMap((line) => {
    const fields = line.split("\t");
    if (
      fields.length !== 12 ||
      fields[0] !== "5" ||
      fields[11]?.trim().toLowerCase() !== label.toLowerCase()
    )
      return [];
    const [left, top, width, height, confidence] = fields
      .slice(6, 11)
      .map(Number);
    if (
      left === undefined ||
      top === undefined ||
      width === undefined ||
      height === undefined ||
      confidence === undefined ||
      ![left, top, width, height, confidence].every(Number.isFinite) ||
      confidence < 70 ||
      width <= 0 ||
      height <= 0 ||
      left < bounds.left ||
      top < bounds.top ||
      left + width > bounds.right ||
      top + height > bounds.bottom
    )
      return [];
    return [
      { x: Math.round(left + width / 2), y: Math.round(top + height / 2) },
    ];
  });
}

/** A click target only when exactly one recognized word matches. */
export function desktopTextTarget(
  tsv: string,
  label: string,
  bounds = { left: 0, top: 0, right: 1280, bottom: 720 },
) {
  const matches = desktopTextMatches(tsv, label, bounds);
  return matches.length === 1 ? matches[0] : undefined;
}

const activeButton = (rgb: Uint8Array, width: number) => {
  // Only an active button counts; modal backdrops dim the underlying controls.
  return (left: number, top: number) => {
    let green = 0;
    for (let y = top; y < top + 16; y++) {
      for (let x = left; x < left + 16; x++) {
        const index = (y * width + x) * 3;
        if (
          (rgb[index] ?? 255) < 70 &&
          (rgb[index + 1] ?? 0) > 140 &&
          (rgb[index + 2] ?? 255) < 140
        )
          green++;
      }
    }
    return green >= 230;
  };
};

/**
 * The Install button of a configurable addon's manifest dialog. It sits lower
 * as the dialog grows with a long, wrapped add-on URL.
 */
export function desktopConfigurableInstall(
  rgb: Uint8Array,
  width: number,
  height: number,
) {
  if (width !== 1280 || height !== 720 || rgb.length !== width * height * 3)
    return undefined;
  const active = activeButton(rgb, width);
  for (let y = 500; y <= 690; y += 4) if (active(880, y)) return { x: 782, y };
  return undefined;
}

/** The region hiding a private add-on URL in retained installation frames. */
export function desktopSecretBox(
  rgb: Uint8Array,
  width: number,
  height: number,
) {
  const install = desktopConfigurableInstall(rgb, width, height);
  return install
    ? { left: 340, top: 140, width: 600, height: install.y - 152 }
    : { left: 340, top: 340, width: 600, height: 56 };
}

export function desktopInstallStage(
  rgb: Uint8Array,
  width: number,
  height: number,
): DesktopInstallStage | undefined {
  if (width !== 1280 || height !== 720 || rgb.length !== width * height * 3)
    return undefined;
  const active = activeButton(rgb, width);
  if (active(675, 522) || desktopConfigurableInstall(rgb, width, height))
    return "manifest";
  if (active(675, 462)) return "add-url";
  if (active(846, 114)) return "addons";
  return undefined;
}

export function desktopInstallationPassed(proof: {
  guestPassed: boolean;
  manifestStage: DesktopInstallStage | undefined;
  installedStage: DesktopInstallStage | undefined;
  streamRequests: number;
}) {
  return (
    proof.guestPassed &&
    proof.manifestStage === "manifest" &&
    proof.installedStage === "addons" &&
    proof.streamRequests > 0
  );
}

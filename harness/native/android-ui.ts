export const allowedTvLabels = [
  "Stremio",
  "Guest",
  "Continue as guest",
  "Log in",
  "Login",
  "Sign in",
  "Sign up",
  "Addons",
  "Add-ons",
  "Install",
  "Settings",
  "Home",
  "Library",
  "Link Account",
  "Sync Addons",
  "Expires in",
  "Login code refreshed",
  "Request a new link",
  "Scan QR Code above or go to",
  "Log in to your Stremio account",
  "You need to login",
  "The Stremio Team",
  "Thank you for understanding,",
] as const;

const allowed = new Set(allowedTvLabels.map((label) => label.toLowerCase()));

const pairingCode = /^(?:[A-Z0-9]{4,8}|[A-Z0-9]{4}-[A-Z0-9]{4})$/i;

const loginWallLabels = new Set(
  [
    "Link Account",
    "Scan QR Code above or go to",
    "Log in to your Stremio account",
    "You need to login",
    "Login code refreshed",
  ].map((label) => label.toLowerCase()),
);

export interface TvUiClassification {
  clientWindow: boolean;
  loginWall: boolean;
  pairingChallenge: boolean;
  guest: boolean;
  uiText: string[];
}

const visibleText = (xml: string) =>
  [...xml.matchAll(/(?:text|content-desc)="([^"]*)"/g)]
    .map(([, value]) => value ?? "")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

export const keepTvLabel = (value: string) => {
  if (/https?:\/\//i.test(value) || value.includes("@")) return false;
  if (pairingCode.test(value)) return false;
  return allowed.has(value.toLowerCase());
};

const hasLoginWallText = (value: string) => {
  const lower = value.toLowerCase();
  return [...loginWallLabels].some(
    (label) => lower === label || lower.startsWith(label),
  );
};

export const classifyTvHierarchy = (
  xml: string,
  packageName: string,
): TvUiClassification => {
  const nodes = visibleText(xml);
  const labels = nodes.filter(keepTvLabel);
  const lower = new Set(labels.map((label) => label.toLowerCase()));
  const loginWall = nodes.some(hasLoginWallText);
  return {
    clientWindow: xml.includes(`package="${packageName}"`),
    loginWall,
    pairingChallenge: loginWall,
    guest: lower.has("guest") || lower.has("continue as guest"),
    uiText: [...new Set(labels)],
  };
};

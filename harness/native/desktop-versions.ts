// Flathub keeps signatures only for each ref's newest builds, and the GNOME
// runtime rebuilds within days. The client stays on an exact commit; the
// runtime follows its branch's signed head and receipts record its commit.
const x64 = {
  arch: "x86_64",
  client: "com.stremio.Stremio",
  runtime: "org.gnome.Platform/x86_64/50",
  clientCommit:
    "7580e7db921fc46aa1cca51623ec404b5a313dd5868ece9506cac4a42ed92131",
} as const;

const arm64 = {
  arch: "aarch64",
  client: "com.stremio.Stremio",
  runtime: "org.gnome.Platform/aarch64/50",
  clientCommit:
    "3795122e52ba015074cea33480d49aa1b4189efc68205b22e63902cd5c22c39a",
} as const;

export const desktopVersions = process.arch === "arm64" ? arm64 : x64;

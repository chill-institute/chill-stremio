const x64 = {
  arch: "x86_64",
  client: "com.stremio.Stremio",
  runtime: "org.gnome.Platform/x86_64/50",
  clientCommit:
    "7580e7db921fc46aa1cca51623ec404b5a313dd5868ece9506cac4a42ed92131",
  runtimeCommit:
    "fc150bcbb560aebb920738976c963cbdb7f83498d583221dadd942870b1bf307",
} as const;

const arm64 = {
  arch: "aarch64",
  client: "com.stremio.Stremio",
  runtime: "org.gnome.Platform/aarch64/50",
  clientCommit:
    "3795122e52ba015074cea33480d49aa1b4189efc68205b22e63902cd5c22c39a",
  runtimeCommit:
    "2b6d25cb56615cd7e2f4d1bfe2f090306b55844e065850f7ce1dda71b5a9c30f",
} as const;

export const desktopVersions = process.arch === "arm64" ? arm64 : x64;

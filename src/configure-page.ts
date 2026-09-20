import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const configureAssets = new Map(
  [["logo.png", "image/png"]].map(([name, contentType]) => [
    `/configure-assets/${name}`,
    {
      contentType,
      body: readFileSync(
        new URL(`./configure-assets/${name}`, import.meta.url),
      ),
    },
  ]),
);

// Static port of chill-web's AuthPage, FullscreenCenter and Button primitives.
const styles = `
:root {
  color-scheme: light dark;
  --color-app: #d6d3d1;
  --color-surface: #f5f5f4;
  --color-hover: #e7e5e4;
  --color-fg-1: #0c0a09;
  --color-fg-2: #44403c;
  --color-fg-3: #57534e;
  --color-fg-inverse: #f5f5f4;
  --color-border-strong: #0c0a09;
  --color-ring-focus: #0c0a0959;
  --shadow-press: 1px 1px 0 #0c0a09;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--color-app);
  color: var(--color-fg-1);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main {
  display: flex;
  min-height: 100dvh;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
  isolation: isolate;
}
.center { width: 100%; max-width: 480px; transform: translateY(-4vh); }
.auth-page {
  overflow: hidden;
  width: 100%;
  border: 1px solid var(--color-border-strong);
  border-radius: .75rem;
  background: var(--color-surface);
  box-shadow: var(--shadow-press);
}
.page-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.25rem;
  padding: 1.5rem 1.75rem;
  border-bottom: 1px solid var(--color-border-strong);
  text-align: center;
}
.logo { width: 4rem; height: 4rem; flex-shrink: 0; border: 1px solid var(--color-border-strong); border-radius: .25rem; }
.heading { min-width: 0; width: 100%; }
h1 { margin: 0; font-family: ui-serif, Georgia, serif; font-weight: 400; font-size: 1.625rem; line-height: 1; letter-spacing: -.01em; text-wrap: balance; }
p { margin: 0; text-wrap: pretty; }
.description { margin-top: .5rem; color: var(--color-fg-3); font-size: .875rem; line-height: 1.2; }
.page-body { display: flex; flex-direction: column; gap: 1rem; padding: 1.5rem 1.75rem; }
.copy { color: var(--color-fg-3); font-size: .875rem; line-height: 1.4; }
a { color: inherit; text-underline-offset: .25rem; }
a:focus-visible { outline: none; border-radius: .25rem; box-shadow: 0 0 0 2px var(--color-app), 0 0 0 4px var(--color-ring-focus); }
.action { font-size: .9375rem; line-height: 1; }
.button {
  position: relative;
  display: inline-flex;
  width: 100%;
  min-height: 2.25rem;
  align-items: center;
  justify-content: center;
  gap: .25rem;
  padding: .375rem .875rem;
  border: 1px solid var(--color-border-strong);
  border-radius: .25rem;
  background: var(--color-fg-1);
  color: var(--color-fg-inverse);
  box-shadow: var(--shadow-press);
  text-decoration: none;
  cursor: pointer;
}
.touch-target { position: absolute; top: 50%; left: 50%; width: max(100%, 3rem); height: max(100%, 3rem); transform: translate(-50%, -50%); }
@media (pointer: fine) { .touch-target { display: none; } }
.button:active { transform: translate(1px, 1px); box-shadow: none; }
.meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .5rem 1rem; color: var(--color-fg-3); font-size: .875rem; line-height: 1.4; }
@media (hover: hover) {
  .button:hover { background: var(--color-fg-2); }
  .meta a:hover { color: var(--color-fg-1); }
}
@media (prefers-reduced-motion: no-preference) {
  .button { transition: transform 140ms cubic-bezier(.23,1,.32,1); }
}
@media (min-width: 640px) {
  .page-head { gap: 1.5rem; }
  .logo { width: 5rem; height: 5rem; }
  h1 { font-size: 2.25rem; line-height: 1.05; }
}
@media (min-width: 768px) { main { padding: 2rem; } }
@media (max-height: 600px) { .center { transform: none; } }
@media (prefers-color-scheme: dark) {
  :root {
    --color-app: #292524;
    --color-surface: #1c1917;
    --color-hover: #292524;
    --color-fg-1: #f5f5f4;
    --color-fg-2: #e7e5e4;
    --color-fg-3: #d6d3d1;
    --color-fg-inverse: #0c0a09;
    --color-border-strong: #44403c;
    --color-ring-focus: #f5f5f466;
    --shadow-press: 1px 1px 0 #44403c;
  }
}
`;

const styleHash = createHash("sha256").update(styles).digest("base64");
const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function configurePage(webOrigin: string) {
  const setupUrl = escapeAttribute(`${webOrigin}/stremio`);
  return {
    contentSecurityPolicy: `default-src 'none'; style-src 'sha256-${styleHash}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Watch your put.io videos in Stremio. Find movies and shows to download.">
<title>chill.institute for Stremio</title>
<style>${styles}</style>
</head>
<body>
<main>
<div class="center" data-slot="fullscreen-center">
<section class="auth-page" data-slot="auth-page" aria-labelledby="page-title">
<div class="page-head">
<img class="logo" src="/configure-assets/logo.png" width="80" height="80" alt="">
<div class="heading">
<h1 id="page-title">chill.institute for Stremio</h1>
<p class="description">Watch your put.io videos in Stremio. Find movies and shows to download.</p>
</div>
</div>
<div class="page-body">
<p class="copy">Sign in with put.io, then select “install chill”.</p>
<p class="action"><a class="button" href="${setupUrl}"><span class="touch-target" aria-hidden="true"></span>connect your account</a></p>
<div class="meta"><p>Requires a put.io account. Early access.</p><p><a href="${setupUrl}">manage connection</a></p></div>
</div>
</section>
</div>
</main>
</body>
</html>`,
  };
}

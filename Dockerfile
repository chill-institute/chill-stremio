FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN node -e 'const {execFileSync}=require("node:child_process"); const p=require("./package.json").packageManager; execFileSync("npm",["install","--global",p],{stdio:"inherit"})' \
    && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM dependencies AS status-media
RUN apt-get update && apt-get install --yes --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY scripts/status-media.ts ./scripts/status-media.ts
COPY src/status-media.ts ./src/status-media.ts
RUN node scripts/status-media.ts

# Browser lanes on hosts without Chromium libraries; see docs/harness.md.
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d AS browser
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install --yes --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY package.json /tmp/package.json
RUN node -e 'const {execFileSync}=require("node:child_process"); const p=require("/tmp/package.json").packageManager; execFileSync("npm",["install","--global",p],{stdio:"inherit"})' \
    && rm /tmp/package.json && pnpm --version

FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG VERSION=0.0.0
LABEL org.opencontainers.image.source="https://github.com/chill-institute/chill-stremio"
ENV NODE_ENV=production CHILL_LISTEN_HOST=0.0.0.0 CHILL_LISTEN_PORT=7000 CHILL_ADAPTER_VERSION=$VERSION
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=status-media /app/.cache/status-media ./.cache/status-media
USER node
EXPOSE 7000
STOPSIGNAL SIGTERM
CMD ["node", "src/hosted-run.ts"]

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS dependencies
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN node -e 'const {execFileSync}=require("node:child_process"); const p=require("./package.json").packageManager; execFileSync("npm",["install","--global",p],{stdio:"inherit"})' \
    && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM dependencies AS status-media
RUN apt-get update && apt-get install --yes --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY scripts/status-media.ts ./scripts/status-media.ts
COPY src/status-media.ts ./src/status-media.ts
RUN node scripts/status-media.ts

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG VERSION=0.0.0
LABEL org.opencontainers.image.source="https://github.com/chill-institute/chill-stremio"
ENV NODE_ENV=production CHILL_LISTEN_HOST=0.0.0.0 CHILL_LISTEN_PORT=7000 CHILL_STATE_DIRECTORY=/data CHILL_ADAPTER_VERSION=$VERSION
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=status-media /app/.cache/status-media ./.cache/status-media
RUN mkdir /data && chown node:node /data && chmod 0700 /data
USER node
EXPOSE 7000
STOPSIGNAL SIGTERM
CMD ["node", "src/hosted-run.ts"]

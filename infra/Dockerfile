FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps/relay ./apps/relay
COPY apps/daemon/package.json ./apps/daemon/package.json
COPY apps/web ./apps/web
RUN bun install --frozen-lockfile
RUN bun run --filter @agentpanel/web build

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
ENV WEB_DIST=/app/apps/web/dist
ENV HOST=0.0.0.0
EXPOSE 8787
USER bun
CMD ["sh", "-c", "bun apps/relay/src/migrate.ts && bun apps/relay/src/index.ts"]

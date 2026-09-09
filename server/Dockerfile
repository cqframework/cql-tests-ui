# Build from the monorepo root:
#   docker build -f server/Dockerfile -t hlseven/quality-cql-studio-server:latest .

FROM node:26-alpine AS builder
LABEL maintainer="Preston Lee"

WORKDIR /app

COPY package.json package-lock.json ./
COPY core/package.json core/tsconfig.json ./core/
COPY core/src ./core/src
COPY server/package.json server/tsconfig.json server/prisma.config.ts ./server/
COPY server/prisma ./server/prisma
COPY server/src ./server/src
COPY opencode/package.json ./opencode/
COPY ui/package.json ./ui/

# Workspace stubs only for opencode/ui. Ignore scripts during install; server build runs prisma generate.
RUN npm ci --workspace=@cql-studio/server --workspace=@cql-studio/core --include-workspace-root --ignore-scripts

RUN npm run build --workspace=@cql-studio/core \
  && npm run build --workspace=@cql-studio/server

RUN npm prune --omit=dev --ignore-scripts --workspace=@cql-studio/server --workspace=@cql-studio/core --include-workspace-root

FROM node:26-alpine AS runner
LABEL maintainer="Preston Lee"

WORKDIR /app

ENV CQL_STUDIO_SERVER_NODE_ENV=production
ENV CQL_STUDIO_SERVER_PORT=3003

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/core/package.json ./core/
COPY --from=builder /app/core/build ./core/build
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/prisma ./server/prisma
COPY --from=builder /app/server/prisma.config.ts ./server/

WORKDIR /app/server
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "import('node:http').then(m => {const req = m.request('http://localhost:3003/health', {timeout: 2000}, (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}); req.on('error', () => process.exit(1)); req.end();})"

CMD ["node", "dist/server.js"]

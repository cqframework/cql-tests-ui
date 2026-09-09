# Build from the monorepo root:
#   docker build -f opencode/Dockerfile -t hlseven/quality-cql-studio-opencode:latest .

FROM node:26-alpine AS builder
LABEL maintainer="Preston Lee"

WORKDIR /app

COPY package.json package-lock.json ./
COPY core/package.json core/tsconfig.json ./core/
COPY core/src ./core/src
COPY opencode/package.json opencode/tsconfig.json ./opencode/
COPY opencode/src ./opencode/src
COPY server/package.json ./server/
COPY ui/package.json ./ui/

# Workspace stubs only for server/ui. Ignore scripts; run OpenCode musl postinstall afterward.
RUN npm ci --workspace=@cql-studio/opencode --workspace=@cql-studio/core --include-workspace-root --ignore-scripts \
  && node node_modules/opencode-ai/postinstall.mjs

RUN npm run build --workspace=@cql-studio/core \
  && npm run build --workspace=@cql-studio/opencode

RUN npm prune --omit=dev --ignore-scripts --workspace=@cql-studio/opencode --workspace=@cql-studio/core --include-workspace-root

FROM node:26-alpine AS runner
LABEL maintainer="Preston Lee"

WORKDIR /app

ENV CQL_STUDIO_OPENCODE_NODE_ENV=production
ENV CQL_STUDIO_OPENCODE_RUNNER_HOST=0.0.0.0
ENV CQL_STUDIO_OPENCODE_RUNNER_PORT=4097
ENV CQL_STUDIO_OPENCODE_INTERNAL_PORT=4096
ENV CQL_STUDIO_OPENCODE_WORKSPACE_ROOT=/app/opencode/workspaces
ENV PATH="/app/node_modules/.bin:${PATH}"

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/core/package.json ./core/
COPY --from=builder /app/core/build ./core/build
COPY --from=builder /app/opencode/package.json ./opencode/
COPY --from=builder /app/opencode/dist ./opencode/dist

WORKDIR /app/opencode
EXPOSE 4097

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "import('node:http').then(m => {const req = m.request('http://localhost:4097/health', {timeout: 2000}, (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}); req.on('error', () => process.exit(1)); req.end();})"

CMD ["node", "dist/runner.js"]

# Build from the monorepo root:
#   docker build -f ui/Dockerfile -t hlseven/quality-cql-studio:latest .

FROM node:26-alpine AS builder
LABEL maintainer="Preston Lee"

WORKDIR /app

COPY package.json package-lock.json ./
COPY core/package.json core/tsconfig.json ./core/
COPY core/src ./core/src
COPY ui/package.json ui/tsconfig.json ui/tsconfig.app.json ui/angular.json ./ui/
COPY server/package.json ./server/
COPY opencode/package.json ./opencode/

# Workspace stubs only for server/opencode; skip lifecycle scripts (server prisma postinstall).
RUN npm ci --ignore-scripts

COPY ui ./ui

RUN npm run build --workspace=@cql-studio/core \
  && npm run build --workspace=@cql-studio/ui

FROM nginx:stable-alpine
LABEL maintainer="Preston Lee"

COPY ui/nginx.conf /etc/nginx/conf.d/default.conf

WORKDIR /usr/share/nginx/html
RUN rm -rf ./*

COPY --from=builder /app/ui/dist/cql-studio/browser .

COPY ui/entrypoint.sh .
CMD ["./entrypoint.sh"]

#!/usr/bin/env bash

docker buildx build --platform linux/arm64,linux/amd64 -f ui/Dockerfile -t hlseven/quality-cql-studio:latest .
docker buildx build --platform linux/arm64,linux/amd64 -f server/Dockerfile -t hlseven/quality-cql-studio-server:latest .
docker buildx build --platform linux/arm64,linux/amd64 -f opencode/Dockerfile -t hlseven/quality-cql-studio-opencode:latest .

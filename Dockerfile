# syntax=docker/dockerfile:1

# ---------- stage 1: pull the litestream binary ----------
# Litestream gives us continuous SQLite replication to an S3-compatible
# bucket (Backblaze B2, AWS S3, Cloudflare R2…). Activated at runtime by
# setting LITESTREAM_BUCKET + credentials; no-op otherwise.
FROM alpine:3.20 AS litestream
ARG TARGETARCH
ARG LITESTREAM_VERSION=0.3.13
RUN apk add --no-cache curl ca-certificates \
 && case "${TARGETARCH:-amd64}" in \
      amd64) ARCH=amd64 ;; \
      arm64) ARCH=arm64 ;; \
      *)     ARCH=amd64 ;; \
    esac \
 && curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin \
 && chmod +x /usr/local/bin/litestream

# ---------- stage 2: the application image ----------
# Uses Node 22 which ships node:sqlite — zero native compilation needed.
FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the rest of the source.
COPY . .

# Bundle litestream + its config + the entrypoint.
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY litestream.yml /etc/litestream.yml
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# The SQLite file lives on a persistent volume mounted at /data.
RUN mkdir -p /data

EXPOSE 3000

# The entrypoint runs Node directly if no backup is configured, or under
# `litestream replicate -exec` when LITESTREAM_BUCKET is set.
CMD ["/app/docker-entrypoint.sh"]

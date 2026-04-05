# syntax=docker/dockerfile:1
# Small, production image for the coffee loyalty server.
# Uses Node 22 which ships node:sqlite — zero native compilation needed.
FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the rest of the source.
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

# The SQLite file lives on a persistent volume mounted at /data.
# Create the directory in case the volume mount is empty on first boot.
RUN mkdir -p /data

EXPOSE 3000

# Use the built-in init so SIGTERM is forwarded to Node for graceful shutdown.
CMD ["node", "server.js"]

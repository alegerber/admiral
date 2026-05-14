# syntax=docker/dockerfile:1.7

# ---- deps: install all dependencies (incl. dev, needed for vite build) ----
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install

# ---- build: compile the Vite frontend into ./dist ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN cd src/frontend && bunx vite build \
 && rm -rf /app/dist \
 && cp -r src/frontend/dist /app/dist

# ---- runtime: slim Bun image, no dev tooling ----
FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3031

# Install only production deps fresh (smaller than copying node_modules from build)
COPY package.json bun.lock* ./
RUN bun install --production

# Server source + built SPA
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/dist ./dist

# Bun image already provides a non-root `bun` user (uid 1000)
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

EXPOSE 3031
CMD ["bun", "run", "src/server/index.ts"]

# Docker Deployment (Hetzner VPS + Cloudflare Tunnel)

This guide describes how to run Admiral on a Hetzner Cloud VPS (or any
Linux box) behind a Cloudflare Tunnel, with no inbound ports exposed
to the public internet.

The repo ships four files that make this work:

- `Dockerfile`         — multi-stage Bun build for Admiral.
- `docker-compose.yml` — Admiral + `cloudflared` sidecar on a private network.
- `.dockerignore`      — keeps the build context lean and secret-free.
- `.env.example`       — placeholder for the Cloudflare Tunnel token.

## Architecture

```
Browser ──HTTPS──▶ Cloudflare Edge ──tunnel──▶ cloudflared ──HTTP──▶ admiral:3031
                                              (sidecar)            (container)
```

- Admiral listens only on the internal Docker network (`expose: 3031`,
  no host port mapping). The VPS firewall sees no inbound traffic to
  Admiral at all.
- `cloudflared` opens an *outbound* connection from the VPS to
  Cloudflare's edge. Cloudflare terminates TLS and forwards requests
  to the sidecar, which forwards them to `admiral:3031` over the
  Compose network.
- SQLite state lives in `./data` on the host via a bind mount, so
  rebuilds and image updates do not drop profiles, logs, or settings.

## What the files do

### `Dockerfile`

Three stages:

1. **`deps`** — installs everything (including dev deps). Vite, React,
   and the rest of the frontend toolchain are needed at build time.
2. **`build`** — runs `vite build` inside `src/frontend` and copies the
   output to `/app/dist`, replicating `scripts/build.ts`.
3. **`runtime`** — `oven/bun:1-slim`, runs `bun install --production`
   from scratch (smaller than copying the build's `node_modules`),
   then copies only `src/server` and `dist`. Drops to the non-root
   `bun` user provided by the base image and runs `bun run
   src/server/index.ts` directly — no `--compile` step, because the
   local macOS binary would not run inside a Linux container.

### `docker-compose.yml`

Two services on a private bridge network:

- **`admiral`** — built from the Dockerfile. No `ports:` mapping —
  only `expose: 3031`, which makes the port visible to other Compose
  services but invisible to the VPS firewall. A healthcheck hits
  `/api/health` every 30 s.
- **`cloudflared`** — `cloudflare/cloudflared:latest`, runs `tunnel
  run` with the token from `.env`. Uses `depends_on … condition:
  service_healthy` so the tunnel only attaches once Admiral actually
  responds, avoiding 502s during cold start.

The `${CLOUDFLARE_TUNNEL_TOKEN:?...}` syntax makes `docker compose
up` fail loudly if the token is missing, instead of letting
`cloudflared` crash-loop and flood the logs.

### `.dockerignore`

Excludes `node_modules`, `dist`, `data`, the local `admiral` binary,
`.git`, `.env*`, and the SQLite DB files. Faster builds and zero risk
of baking the database or secrets into a published image.

### `.env.example`

Holds the `CLOUDFLARE_TUNNEL_TOKEN` placeholder plus inline
instructions for the Cloudflare dashboard side.

## Setup on the VPS

```bash
# Prereqs: Docker engine + the Compose plugin
ssh root@your-vps
apt update && apt install -y docker.io docker-compose-plugin

# Clone the code
git clone https://github.com/SpaceMolt/admiral.git
cd admiral

# Add the tunnel token (instructions inline in the example file)
cp .env.example .env
nano .env   # paste CLOUDFLARE_TUNNEL_TOKEN=eyJh...

# Pre-create the data dir so it's writable by the container (uid 1000)
mkdir -p data && chown -R 1000:1000 data

# Build and start
docker compose up -d --build

# Tail logs to confirm everything came up
docker compose logs -f
```

Healthy startup logs look like:

- Admiral prints `Admiral listening on http://0.0.0.0:3031`.
- `cloudflared` reports four registered tunnel connections, one per
  Cloudflare edge region.

## Cloudflare dashboard configuration

1. **Create the tunnel** — Zero Trust → Networks → Tunnels → "Create a
   tunnel" → Cloudflared → name it (e.g. `admiral-vps`) → copy the
   token → paste into `.env`.
2. **Add a public hostname** under the same tunnel:
   - Subdomain: `admiral`
   - Domain: `your-domain.tld`
   - Service: **HTTP** → `admiral:3031`

   `admiral` here is the Compose service name; Docker's internal DNS
   resolves it for `cloudflared`.
3. **Add Cloudflare Access** *(strongly recommended)* — Zero Trust →
   Access → Applications → Add → Self-hosted → `admiral.your-domain
   .tld` → policy with your email allow-list. Without this, anyone who
   guesses the subdomain reaches the Admiral UI and the LLM API keys
   stored inside it.

## Common pitfalls

- **`./data` permission denied** on first boot: Docker created the
  directory as root before you `chown`'d it.
  Fix: `sudo chown -R 1000:1000 ./data && docker compose restart admiral`.
- **`@mariozechner/pi-ai: "latest"`** in `package.json` is unpinned,
  and `bun.lock` is in `.gitignore`. A build on your laptop and a
  build on the VPS can resolve to different versions. If you need
  reproducibility, pin the version or commit `bun.lock`.
- **SSE streams dropping after ~100 s** through Cloudflare: only a
  risk if heartbeats grow past that interval. The current code is well
  inside the limit (`idleTimeout: 120` in `src/server/index.ts`).
- **Cloudflare Access not active**: anyone with the URL reaches the
  UI and the stored provider keys. Treat this as required, not
  optional.

## Updates

```bash
git pull
docker compose up -d --build
```

The image rebuilds; the `./data` bind mount is untouched, so profiles,
logs, and the SQLite WAL survive cleanly. To roll back, `git checkout`
an older commit and rebuild.

## Tearing it down

```bash
docker compose down            # stop containers, keep data
docker compose down -v         # stop containers AND remove named volumes
                               # (the ./data bind mount is NOT affected)
rm -rf data                    # manually drop the SQLite database
```

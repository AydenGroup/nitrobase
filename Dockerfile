FROM oven/bun:1.3.2-alpine

# util-linux for nsenter & script (PTY emulation), bash for interactive shell,
# openssh-keygen to generate SSH keys (src/server/services/ssh-keygen.ts),
# postgresql16-client for the self-backup (pg_dump; same major as the DB image),
# nodejs to run the server: the build uses nitro's `node` preset, whose
# WebSocket adapter (crossws) refuses to start under Bun, and Node keeps the
# DNS `lookup` pinning used by the SSRF guards. Bun still installs, builds
# and runs migrations.
RUN apk add --no-cache util-linux bash openssh-keygen postgresql16-client nodejs

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

EXPOSE 3000
# "healthy" once the server answers and reaches its database (migrations run
# first). The in-panel updater waits for it before keeping a new version.
HEALTHCHECK --interval=10s --timeout=5s --start-period=180s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["sh", "-c", "bun run db:migrate && node .output/server/index.mjs"]

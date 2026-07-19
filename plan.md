## Plan: Sassbase VPS PaaS

Build self-hosted Dokploy-like clone for one or more VPS servers. Use TanStack Start as full-stack app, Bun runtime, PostgreSQL, Drizzle ORM, Docker, Traefik, SSH automation, and one-click self-host deployment of multiple BaaS stacks. Recommended architecture: keep backend inside TanStack Start server functions/API routes first; add separate agent only when long-running jobs/log streaming exceed app process limits.

Designed for extensibility: provider abstraction layer under `src/server/services/providers/` so each BaaS engine (Supabase, Appwrite, PocketBase) shares the same deploy flow. Supabase ships first; Appwrite and PocketBase follow the same pattern.

**Steps**

### Phase 0 — Stack decision and cleanup

1. Keep `TanStack Start` for frontend + backend in same app. Use its server-side route/API layer for CRUD, deployment triggers, and config generation. This avoids separate Hono/Express service for MVP.
2. Use `Bun` as runtime and package runner for dev/prod. Replace Cloudflare Worker deployment assumptions with Bun/Node-compatible server target.
3. Use `PostgreSQL + Drizzle`. PostgreSQL handles concurrent writes from deployments/logs/SSH sessions better than SQLite. Drizzle already exists in workspace and is lighter than Prisma.
4. Remove Cloudflare-specific deployment path from MVP (`@cloudflare/vite-plugin`, `wrangler.jsonc`) only if it blocks Bun/Node SSR. Keep file untouched until migration test confirms exact replacement.

### Phase 1 — Database foundation

5. Convert Drizzle schema from SQLite to PostgreSQL:
   - `servers`: VPS metadata (`id`, `name`, `host`, `port`, `username`, `status`, timestamps).
   - `ssh_keys`: encrypted private/public key records.
   - `apps`: deployable units (`type`: `supabase`, `appwrite`, `pocketbase`, `docker-compose` later), config JSON, server relation.

- `providers`: registry of supported BaaS engines (name, image versions, config schema, status).
  - `domains`: host, https flag, certificate type (`letsencrypt`, `custom`, `none`), app relation.
  - `deployments`: status, log path/log chunks, started/finished timestamps.
  - `traefik_files`: optional persisted snapshots of generated config.

6. Update `drizzle.config.ts` to `dialect: "postgresql"` and use `DATABASE_URL` PostgreSQL connection string.
7. Update `src/db/index.ts` from `drizzle-orm/better-sqlite3` to PostgreSQL driver (`drizzle-orm/node-postgres` with `pg`, or Bun-compatible postgres client if selected during implementation).
8. Add minimal migrations and seed/admin bootstrap only if auth lands in MVP.

### Phase 2 — TanStack Start backend API

9. Create backend endpoints/server functions inside TanStack Start for:
   - Server CRUD and SSH validation.
   - Server bootstrap.
   - Traefik config read/write/regenerate.
   - Supabase deploy trigger.
   - Deployment status/log fetch.
10. Keep API boundary boring: validate input, call service, return JSON. No extra framework unless TanStack Start backend becomes limiting.
11. Add service layer under `src/server/services/`:

- `ssh.ts`: `ssh2` wrapper with `execRemote(serverId, command)`.
- `docker.ts`: Docker command helpers first; Dockerode only when API access needed.
- `traefik.ts`: static + dynamic YAML generators.
- `server-setup.ts`: idempotent VPS bootstrap script builder.
- `providers/` — abstraction layer (base `DeployProvider` interface):
- `supabase.ts`: compose/env generator and Supabase deployment flow.
- `appwrite.ts`: Appwrite compose/env generator (Postgres, Redis, Traefik labels).
- `pocketbase.ts`: PocketBase single binary + Traefik config.
- `compose.ts`: generic docker-compose deploy for future custom apps.

### Phase 3 — Remote server bootstrap

12. Implement add-server flow:

- User inputs host, port, username, private key.
- Backend validates SSH connection with `ssh2`.
- Store encrypted private key in PostgreSQL.
- Run validation checks: OS, sudo access, Docker installed, ports 80/443 available.

13. Bootstrap VPS idempotently:

- Install Docker if missing.
- Start/enable Docker.
- Create Docker network `sassbase-network` (or `dokploy-network` compatibility if reusing Dokploy patterns).
- Create directories `/etc/sassbase/traefik`, `/etc/sassbase/traefik/dynamic`, `/etc/sassbase/apps`, `/etc/sassbase/logs`.
- Write `/etc/sassbase/traefik/traefik.yml`.
- Write `/etc/sassbase/traefik/dynamic/middlewares.yml`.
- Start `sassbase-traefik` container with ports `80:80`, `443:443/tcp`, `443:443/udp`, Docker socket mount, config mounts, restart always.

14. Make bootstrap safe to rerun: check before install/create/write; update only managed files.

### Phase 4 — Traefik and HTTPS

15. Generate static Traefik config:

- EntryPoints `web` (`:80`) and `websecure` (`:443`).
- Docker provider with `exposedByDefault: false`, `watch: true`, network `sassbase-network`.
- File provider with directory `/etc/sassbase/traefik/dynamic`, `watch: true`.
- ACME resolver `letsencrypt` with `httpChallenge.entryPoint: web` and storage `/etc/sassbase/traefik/dynamic/acme.json`.

16. Generate dynamic config per app/domain:

- HTTP router for redirect to HTTPS.
- HTTPS router on `websecure` with `tls.certResolver = "letsencrypt"` when domain uses Let's Encrypt.
- Service target points to container/service internal URL, e.g. `http://supabase-kong:8000` or `http://supabase-studio:3000`.

17. Store canonical desired config in PostgreSQL; write rendered YAML to VPS filesystem. Filesystem remains source consumed by Traefik, DB remains source for UI/regeneration.

### Phase 5 — Provider-based one-click deploy

18. Build provider registry and shared deploy contract:

- Provider metadata: `id`, display name, version matrix, required secrets, required domains, health checks.
- Shared methods: `generateEnv`, `generateCompose`, `generateTraefikTargets`, `postDeployChecks`.

19. Build Supabase first:

- Deploy wizard selects server.
- Input base domain(s): API domain, Studio domain, optional auth/storage/realtime domains if split.
- Generate secure secrets: JWT secret, anon/service role keys, Postgres password, dashboard credentials.
- Generate compose under `/etc/sassbase/apps/supabase/docker-compose.yml`.
- Use official Supabase self-host compose pattern, pinned image versions. Keep first MVP minimal: Postgres, Kong, Auth, REST, Realtime, Storage, Studio, Meta, Imgproxy if needed.

20. Design next providers against same contract:

- `Appwrite`: compose for Appwrite services plus MariaDB/Postgres, Redis, workers, reverse proxy targets.
- `PocketBase`: minimal single-service deploy with persistent volume and admin bootstrap path.

21. Shared deployment flow for all providers:

- Upload `.env` + `docker-compose.yml` via SSH.
- Run `docker compose up -d`.
- Generate Traefik dynamic config from provider targets.
- Run provider-specific health checks.

22. Record deployment status, provider type, and logs in PostgreSQL.

### Phase 6 — Dashboard UI

24. Build routes/pages:

- `/` dashboard summary.
- `/servers` list + add VPS.
- `/servers/$serverId` status, Docker info, Traefik health.
- `/providers` supported stacks overview.
- `/deploy/supabase/new` one-click deploy wizard.
- `/deploy/appwrite/new` scaffold next provider wizard.
- `/deploy/pocketbase/new` scaffold next provider wizard.
- `/apps/$appId` app status, domains, deployments.
- `/deployments/$deploymentId` logs.

25. Use TanStack Router loaders/actions or server functions for data access. Keep React Query for polling deployment/log status.
26. Add minimal auth before exposing beyond private network: password login/session or reverse-proxy basic auth. Do not expose raw server management unauthenticated.

### Phase 7 — CLI

27. Add Bun CLI entry later, after API stabilizes:

- `sassbase server add`
- `sassbase server bootstrap`
- `sassbase supabase deploy`
- `sassbase logs`

28. CLI should call same backend API or import same service functions in local/admin mode. Avoid duplicate deployment logic.

### Phase 8 — Verification

29. Local verification:

- `bun install`
- `bun run dev`
- `bun run db:generate`
- `bun run db:migrate`
- `bun run test`
- `bun run check`

30. VPS verification:

- Add fresh Ubuntu VPS.
- SSH validation passes.
- Bootstrap rerun twice without destructive changes.
- `docker ps` shows `sassbase-traefik` healthy.
- `/etc/sassbase/traefik/traefik.yml` exists.
- `/etc/sassbase/traefik/dynamic/acme.json` exists with `chmod 600`.

31. Supabase verification:

- Deploy Supabase.
- `docker compose ps` shows core services healthy.
- API domain receives valid Let's Encrypt cert.
- Studio domain opens behind auth.
- Deployment logs visible in dashboard.

**Relevant files**

- `/Volumes/DATA/sassbase/package.json` — switch scripts to Bun-compatible commands; add `pg`, `ssh2`, `yaml`, optional Docker helpers.
- `/Volumes/DATA/sassbase/vite.config.ts` — remove/replace Cloudflare plugin if Bun/Node SSR requires it.
- `/Volumes/DATA/sassbase/wrangler.jsonc` — out of MVP if no Cloudflare deployment.
- `/Volumes/DATA/sassbase/drizzle.config.ts` — change to PostgreSQL dialect and credentials.
- `/Volumes/DATA/sassbase/src/db/schema.ts` — replace demo `todos` SQLite schema with PaaS PostgreSQL schema.
- `/Volumes/DATA/sassbase/src/db/index.ts` — switch from `better-sqlite3` to PostgreSQL Drizzle connection.
- `/Volumes/DATA/sassbase/src/routes/` — add dashboard/routes for servers, apps, deployments, Supabase wizard.
- `/Volumes/DATA/sassbase/src/server/services/ssh.ts` — new SSH helper using `ssh2`.
- `/Volumes/DATA/sassbase/src/server/services/server-setup.ts` — new idempotent VPS bootstrap scripts.
- `/Volumes/DATA/sassbase/src/server/services/traefik.ts` — new Traefik static/dynamic config generators.
- `/Volumes/DATA/sassbase/src/server/services/providers/` — provider abstraction and implementations for `supabase`, later `appwrite`, `pocketbase`, and generic compose.
- `/Volumes/DATA/sassbase/src/server/services/providers/supabase.ts` — Supabase compose/env generator and deployment orchestration.
- `/Volumes/DATA/sassbase/src/server/services/providers/appwrite.ts` — Appwrite provider scaffold.
- `/Volumes/DATA/sassbase/src/server/services/providers/pocketbase.ts` — PocketBase provider scaffold.

**Verification**

1. Confirm TanStack Start can run full-stack on Bun/Node without Cloudflare plugin.
2. Confirm PostgreSQL connection and Drizzle migrations work.
3. Confirm SSH to test VPS with stored key works.
4. Confirm Docker install/bootstrap idempotent on clean VPS.
5. Confirm Traefik issues Let's Encrypt certificate through HTTP-01 challenge.
6. Confirm Supabase compose deploy reaches healthy state.

**Decisions**

- Use `PostgreSQL`, not SQLite, because deployment/log/server operations have concurrent writes and Supabase/Appwrite already depend on PostgreSQL.
- Use `Drizzle`, not Prisma, because project already has Drizzle, needs raw SQL-friendly code, and should avoid Prisma engine/runtime weight.
- Use `TanStack Start backend`, not separate Hono/Express, for MVP. Add separate agent only when long-running jobs or distributed execution require it.
- Use `Bun` for runtime/package runner.
- Use file-rendered Traefik config consumed from VPS filesystem; store desired state in PostgreSQL for regeneration.
- Build provider abstraction layer under `providers/`. Supabase ships first; Appwrite and PocketBase follow same contract. This allows adding more BaaS stacks (Supabase, Appwrite, PocketBase) and later generic Docker Compose apps without coupling core deploy flow to one engine.

**Further Considerations**

1. Secret encryption key: must define server-side `APP_SECRET` before storing SSH keys and provider secrets.
2. Auth: required before internet exposure. Smallest option: password login/session or reverse-proxy basic auth.
3. Job execution: TanStack backend can start MVP jobs, but long-running deploys may need a job queue/worker process once deployments become unreliable across restarts.
4. Provider version matrix: track tested/supported image versions for Supabase/Appwrite/PocketBase. Allow user override but warn on untested versions.

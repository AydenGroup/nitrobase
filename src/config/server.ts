import { z } from "zod";
import { CRON_JOB_MODES } from "#/config/cloud-sync.ts";
import {
	NO_DEFAULT_RESTART,
	RESTART_POLICIES,
} from "#/config/restart-policies.ts";
import { APP_NAME, RELEASE_REPO_DEFAULT } from "#/config/shared.ts";
import { TASK_LOCK_POLICIES } from "#/features/tasks/schema.ts";
import { emailSchema } from "#/libs/email.ts";
import { defaultLocale, type Locale, locales } from "#/libs/i18n.ts";
import { internalError } from "#/utils/error.ts";

/**
 * Server-only runtime configuration. Every tunable (paths, images, network
 * names, timeouts, limits, external URLs) is read from the environment with
 * a default here, validated once with zod. Do not import from client code.
 * Secrets (ENCRYPTION_KEY, SESSION_SECRET) are validated in `#/utils/env.ts`.
 */
const int = (fallback: number) =>
	z.coerce.number().int().positive().default(fallback);

const name = /^[a-z0-9][a-z0-9_.-]*$/;

const csv = (value: string) =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

/** `17=postgres:17.6-alpine,16=…` → { "17": "postgres:17.6-alpine", … }. */
const majorImages = (value: string) =>
	Object.fromEntries(
		csv(value)
			.map((entry) => entry.split("="))
			.filter(
				(pair): pair is [string, string] =>
					pair.length === 2 && /^\d{1,2}$/.test(pair[0] ?? ""),
			),
	);

const percent = (fallback: number) =>
	z.coerce.number().min(1).max(100).default(fallback);

/** Telegram Bot API (an override elsewhere is trusted as a private host). */
export const TELEGRAM_DEFAULT_API_URL = "https://api.telegram.org";

const ConfigSchema = z.object({
	// Managed host layout
	NITROBASE_ROOT: z
		.string()
		.regex(/^\/[a-z0-9/_-]+[a-z0-9]$/, "must be an absolute path")
		.default("/etc/nitrobase"),
	NITROBASE_NETWORK: z.string().regex(name).default("nitrobase-network"),

	// Reverse proxy
	TRAEFIK_IMAGE: z.string().min(1).default("traefik:v3.6.25"),
	TRAEFIK_CONTAINER: z.string().regex(name).default("nitrobase-traefik"),
	TRAEFIK_CERT_RESOLVER: z.string().regex(name).default("letsencrypt"),
	/**
	 * Traefik entrypoint for Cloudflare Tunnel traffic. Never published on
	 * the host: only cloudflared (on nitrobase-network) reaches it, so tunnel
	 * hosts can't be requested directly on the server's public :80.
	 */
	TRAEFIK_TUNNEL_PORT: z.coerce
		.number()
		.int()
		.min(1024)
		.max(65535)
		.default(8081),
	/**
	 * Private network of Traefik and cloudflared only. The tunnel entrypoint
	 * listens on Traefik's fixed address in it, so app containers (on
	 * nitrobase-network) can't reach it; Docker isolates bridge networks.
	 */
	TUNNEL_NETWORK: z.string().regex(name).default("nitrobase-tunnel"),
	TUNNEL_SUBNET: z
		.string()
		.regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/)
		.default("172.31.254.0/29"),
	/** Traefik's address in TUNNEL_SUBNET (the tunnel entrypoint binds it). */
	TRAEFIK_TUNNEL_IP: z.ipv4().default("172.31.254.2"),
	/**
	 * HSTS of the `secure-headers` middleware apps can use. Preload asks
	 * browsers to hard-code HTTPS for the domain (hard to undo): set
	 * TRAEFIK_HSTS_PRELOAD=false when app domains may need plain HTTP later.
	 */
	TRAEFIK_HSTS_SECONDS: z.coerce.number().int().min(0).default(31_536_000),
	TRAEFIK_HSTS_PRELOAD: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
	/** bcrypt cost of basic-auth users (Traefik checks it on every request). */
	TRAEFIK_BASIC_AUTH_COST: z.coerce.number().int().min(4).max(14).default(8),
	/** bcrypt cost of panel account passwords. */
	PASSWORD_BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),

	// Server bootstrap (OS families: #/config/host-os.ts)
	/** Docker's apt repository base (`/<distro>` is appended). */
	DOCKER_APT_REPO_URL: z.url().default("https://download.docker.com/linux"),
	/** Keyring file of Docker's apt signing key on the server. */
	DOCKER_APT_KEYRING: z
		.string()
		.regex(/^\/[\w./-]+$/)
		.default("/etc/apt/keyrings/docker.gpg"),
	/** Docker packages bootstrap installs. */
	DOCKER_PACKAGES: z
		.string()
		.default(
			"docker-ce,docker-ce-cli,containerd.io,docker-buildx-plugin,docker-compose-plugin",
		)
		.transform(csv)
		// Debian package names only: they end up in a root shell script.
		.pipe(z.array(z.string().regex(/^[a-z0-9][a-z0-9.+-]*$/)).min(1)),

	// Remote execution
	COMMAND_TIMEOUT_MS: int(10 * 60_000),
	SSH_READY_TIMEOUT_MS: int(10_000),
	SSH_TEST_TIMEOUT_MS: int(5_000),
	SSH_KEEPALIVE_MS: int(10_000),
	TERMINAL_IDLE_TIMEOUT_MS: int(30 * 60_000),
	/** A cancelled command gets SIGTERM, then SIGKILL after this long. */
	PROCESS_KILL_GRACE_MS: int(5_000),
	/** SSH: the panel's own timer fires this long after the remote `timeout`. */
	SSH_TIMEOUT_SLACK_MS: int(15_000),
	/** Upper bound for one out-of-band `stty` resize of the local shell. */
	TERMINAL_RESIZE_TIMEOUT_MS: int(5_000),
	/**
	 * How the default (Localhost) server reaches the host: `auto` detects a
	 * container (/.dockerenv, /run/.containerenv, cgroup v1 or the container
	 * mountinfo of cgroup v2); `container` forces nsenter into PID 1's
	 * namespaces; `host` runs commands directly.
	 */
	LOCAL_EXEC_MODE: z.enum(["auto", "container", "host"]).default("auto"),

	// Job runner
	JOB_FLUSH_INTERVAL_MS: int(500),
	JOB_FLUSH_BATCH_SIZE: int(200),
	JOB_MEMORY_LINES: int(2000),
	SSE_HEARTBEAT_MS: int(15_000),
	/** An app job waiting for its server's lock checks again this often. */
	JOB_LOCK_POLL_MS: int(2_000),
	/** Final log flush of a job: attempts, backoff growing from the base. */
	JOB_FLUSH_RETRIES: int(5),
	JOB_FLUSH_RETRY_BASE_MS: int(500),
	/** Boot work retried after a failure: backoff doubling from base to max. */
	STARTUP_RETRY_BASE_MS: int(2_000),
	STARTUP_RETRY_MAX_MS: int(60_000),

	// Templates
	TEMPLATES_DIR: z.string().min(1).default("templates"),
	GITHUB_API_URL: z.url().default("https://api.github.com"),
	GITHUB_TIMEOUT_MS: int(15_000),
	GITHUB_RAW_URL: z.url().default("https://raw.githubusercontent.com"),
	TEMPLATE_CACHE_TTL_MS: int(60 * 60_000),
	TEMPLATE_EXTRACT_MAX_BYTES: int(20 * 1024 * 1024),
	TEMPLATE_EXTRACT_MAX_FILES: int(2000),

	// Apps
	APP_BUILD_RETRIES: int(3),
	/**
	 * While images are pulled/built (silent with `pull --quiet`), a "still
	 * pulling" line is logged this often.
	 */
	APP_PULL_HEARTBEAT_MS: int(30_000),
	APP_HEALTH_TIMEOUT_MS: int(5 * 60_000),
	APP_HEALTH_INTERVAL_MS: int(5_000),
	APP_HEALTH_PROBE_TIMEOUT_MS: int(60_000),
	/**
	 * Readiness wait: every service must stay ready, with no new restart,
	 * for this long and over this many consecutive samples (a crash-looping
	 * service is `running` between restarts). A template can set its own
	 * time (`[health] stable_seconds`).
	 */
	APP_READY_STABLE_MS: int(20_000),
	APP_READY_STABLE_SAMPLES: int(3),
	/**
	 * Readiness wait: a service whose healthcheck reports `unhealthy` fails
	 * the deploy only when it stays unhealthy for this long and over this
	 * many consecutive samples (a slow first boot is marked unhealthy once
	 * and recovers on the next passing check). A template can set its own
	 * time (`[health] unhealthy_grace_seconds`).
	 */
	APP_UNHEALTHY_GRACE_MS: int(60_000),
	APP_UNHEALTHY_SAMPLES: int(3),
	/**
	 * Restarts of one service that fail the readiness wait
	 * (`APP_RESTART_LOOP`), counted once every service has been up at once (before
	 * that, ×3: first-boot dependency retries). Higher than the monitoring
	 * restart-loop alert (`ALERT_RESTART_LOOP_COUNT`, over 10 min of a
	 * running app): Docker's restart backoff doubles from 100 ms, so 6
	 * restarts take ~6 s of crashing and a real crash loop passes it within
	 * the first minute, while a service that retries a slow dependency a
	 * few times does not fail a deploy. A template can set its own
	 * (`[health] restart_limit`).
	 */
	APP_DEPLOY_RESTART_LIMIT: int(6),
	/**
	 * Readiness wait: last log lines of a crash-looping service matched
	 * against known failure signatures (#/config/failure-signatures.ts),
	 * and how many times one service's logs are read per wait.
	 */
	APP_HINT_LOG_LINES: int(80),
	APP_HINT_MAX_READS: int(5),
	/**
	 * Restart policy the compose transform gives every service that declares
	 * none, so the whole app comes back after a reboot of its host (BUG-015).
	 * Explicit `restart:` values, one-shot jobs other services wait on
	 * (`service_completed_successfully`) and a template's
	 * `no_default_restart` services keep theirs; `none` turns it off.
	 */
	APP_DEFAULT_RESTART: z
		.enum([...RESTART_POLICIES, NO_DEFAULT_RESTART])
		.default("unless-stopped"),
	/** App overview shows CPU/RAM only from samples newer than this. */
	APP_USAGE_MAX_AGE_MS: int(5 * 60_000),
	/**
	 * Pre-flight warns when the sum of memory/CPU limits on a server would
	 * exceed this share of its RAM/cores (percent).
	 */
	RESOURCE_OVERCOMMIT_PERCENT: int(100),

	// Git apps (R2 M1): clone, build, image retention, push webhooks.
	/** Image of the throwaway clone container (git + ssh). */
	GIT_IMAGE: z.string().min(1).default("alpine/git:v2.54.0"),
	/** Clone/fetch time limit (each clone or repository check). */
	GIT_CLONE_TIMEOUT_MS: int(5 * 60_000),
	/** Wizard "Check repository" (ls-remote + shallow clone + detection). */
	GIT_INSPECT_TIMEOUT_MS: int(2 * 60_000),
	/** Memory of the throwaway clone container (MB). */
	GIT_CLONE_MEMORY_MB: int(512),
	/** Wizard deploy keys not attached to an app are removed after this. */
	GIT_PENDING_KEY_TTL_HOURS: int(24),
	/**
	 * BuildKit for app builds: a dedicated buildx builder (docker-container
	 * driver) per server, so a build gets memory/CPU limits (`docker update`
	 * on the builder container before each build) and BuildKit secrets.
	 */
	BUILDKIT_IMAGE: z.string().min(1).default("moby/buildkit:v0.33.1"),
	BUILDX_BUILDER: z.string().regex(name).default("nitrobase-builder"),
	/** Delay of the leftover-folder sweep run once after boot. */
	WORK_SWEEP_BOOT_DELAY_MS: int(60_000),
	/**
	 * Delay of the one-time proxy network migration after boot (BUG-006:
	 * app containers re-attached without their service-name aliases, once
	 * per server; see apps/network-migration.server.ts).
	 */
	NETWORK_MIGRATION_BOOT_DELAY_MS: int(30_000),
	/** An app-scoped job (git build) waits this long for the server lock. */
	JOB_SERVER_LOCK_WAIT_MS: int(30 * 60_000),
	/** Creating/starting the BuildKit builder (first build pulls its image). */
	BUILDKIT_SETUP_TIMEOUT_MS: int(10 * 60_000),
	/** Removing a throwaway git folder (inspect, branch tip check). */
	GIT_CLEANUP_TIMEOUT_MS: int(60_000),
	/** Removing a build folder / pruning the build cache after a build. */
	BUILD_CLEANUP_TIMEOUT_MS: int(2 * 60_000),
	/**
	 * Default build limits (an app may set its own, up to the maximums).
	 * Builds hold only their app's lock (other apps keep deploying), so the
	 * default timeout allows a first Railpack build on a slow link (builder
	 * images are several hundred MB); raise it per app if needed.
	 */
	BUILD_TIMEOUT_SECONDS: int(20 * 60),
	BUILD_MAX_TIMEOUT_SECONDS: int(2 * 60 * 60),
	BUILD_MEMORY_MB: int(2048),
	BUILD_CPUS: z.coerce.number().positive().max(256).default(2),
	/** BuildKit cache kept per server after each build (MB). */
	BUILD_CACHE_KEEP_MB: int(4096),
	/** Successful app images kept per app (rollback targets; live one always kept). */
	GIT_KEEP_IMAGES: int(5),
	GIT_KEEP_IMAGES_MAX: int(50),
	/**
	 * Railpack (https://railpack.com, Railway's maintained successor of
	 * Nixpacks): the CLI is installed in a small tools image built on the
	 * server from the release tarball (sha256-checked), the plan is built by
	 * its BuildKit frontend image. Versions pinned together.
	 */
	RAILPACK_VERSION: z
		.string()
		.regex(/^v\d+\.\d+\.\d+$/)
		.default("v0.40.1"),
	RAILPACK_SHA256_AMD64: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.default(
			"2842de93e68713af9037e0bc0a398d7da78f3b96aa4804303a638db2bc69bd30",
		),
	RAILPACK_SHA256_ARM64: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.default(
			"c24a064b586b8f4f8c2fab44dd5ef19253e4c6cc4e1df793b3ae19cd87f7a5d4",
		),
	RAILPACK_BASE_IMAGE: z.string().min(1).default("alpine:3.22"),
	RAILPACK_FRONTEND_IMAGE: z
		.string()
		.min(1)
		.default("ghcr.io/railwayapp/railpack-frontend:v0.40.1"),
	RAILPACK_DOWNLOAD_URL: z
		.string()
		.min(1)
		.default("https://github.com/railwayapp/railpack/releases/download"),
	/** Static sites: default build image and the server image that serves them. */
	STATIC_BUILD_IMAGE: z.string().min(1).default("node:22-alpine"),
	STATIC_SERVE_IMAGE: z
		.string()
		.min(1)
		.default("joseluisq/static-web-server:2.44.0"),
	/** Push webhooks: quiet time before a build starts (newer pushes reset it). */
	WEBHOOK_DEBOUNCE_MS: int(10_000),
	/** Requests per client IP and per hook per window. */
	WEBHOOK_RATE_LIMIT: int(30),
	WEBHOOK_RATE_WINDOW_MS: int(60_000),
	WEBHOOK_MAX_BODY_BYTES: int(1024 * 1024),
	/** Generic HMAC provider: accepted clock skew of the signed timestamp. */
	WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: int(300),
	WEBHOOK_DELIVERIES_KEPT: int(100),
	/** Provider delivery ids remembered for replay protection (in memory). */
	WEBHOOK_REPLAY_TTL_MS: int(7 * 24 * 60 * 60_000),
	/** A queued build waits at most this long for the server lock. */
	WEBHOOK_QUEUE_MAX_WAIT_MS: int(60 * 60_000),
	/** A queued build starts this long after its server becomes free. */
	WEBHOOK_QUEUE_RETRY_DELAY_MS: int(1_000),
	/** Delivery ids remembered before expired ones are swept. */
	WEBHOOK_REPLAY_MAX_ENTRIES: int(50_000),

	// Scheduled tasks per app (M8)
	/** Default and maximum run time of one task run (seconds). */
	TASK_DEFAULT_TIMEOUT_SECONDS: int(300),
	TASK_MAX_TIMEOUT_SECONDS: int(30 * 60),
	/** Job log lines one run may write (the run keeps its own output tail). */
	TASK_LOG_MAX_LINES: int(500),
	/** Output kept per run (tail, bytes). */
	TASK_OUTPUT_MAX_BYTES: int(64 * 1024),
	/** Runs kept per task (older ones are deleted). */
	TASK_RUNS_KEPT: int(50),
	/** Tasks per app. */
	TASK_MAX_PER_APP: int(20),
	/** Smallest interval between two scheduled runs (minutes). */
	TASK_MIN_INTERVAL_MINUTES: int(5),
	/**
	 * Default when the server is busy (a deploy/backup holds its lock):
	 * "skip" the run (recorded as skipped) or "queue" it until idle.
	 */
	TASK_LOCK_POLICY: z.enum(TASK_LOCK_POLICIES).default("skip"),
	/** A queued run gives up after waiting this long for the server. */
	TASK_QUEUE_MAX_WAIT_MS: int(30 * 60_000),
	/** Upper bound for one live log stream (client disconnect ends it sooner). */
	APP_LOG_STREAM_MAX_MS: int(24 * 60 * 60_000),
	/** Env names masked even when the template doesn't mark them secret. */
	SECRET_ENV_NAME_PATTERN: z
		.string()
		.default("(PASS|SECRET|TOKEN|PRIVATE|_KEY$|^KEY$|ENC_KEY|CRYPTO)"),
	/** Image used to probe app HTTP health from the proxy network. */
	APP_HEALTH_IMAGE: z.string().min(1).default("curlimages/curl:8.16.0"),
	APP_LOGS_TAIL_DEFAULT: int(200),
	APP_LOGS_TAIL_MAX: int(5000),
	/** Concurrent live log streams per user (each holds an SSH channel). */
	APP_LOG_STREAMS_PER_USER: int(4),
	/** Minimum gap between automatic "apply pending routes" attempts per app. */
	ROUTES_RETRY_BACKOFF_MS: int(10 * 60_000),
	/** Address whose route reveals a server's public source IP (`ip route get`). */
	PUBLIC_IP_PROBE_HOST: z.ipv4().default("1.1.1.1"),
	/** Free domain provider id (see #/server/services/domains/free-domains.ts). */
	FREE_DOMAIN_PROVIDER: z.string().default("sslip.io"),
	/**
	 * Domains are checked again this long after a deploy or a routes change
	 * (Traefik reload + certificate issuance).
	 */
	DOMAIN_RECHECK_DELAY_MS: int(20_000),
	DOMAIN_CHECK_TIMEOUT_MS: int(8_000),
	CERT_EXPIRY_WARNING_DAYS: int(14),

	/** Host ports an app may never publish (template `[[ports]]`). */
	APP_RESERVED_HOST_PORTS: z
		.string()
		.default("22,80,443,2375,2376,3000")
		.transform((value) =>
			value
				.split(",")
				.map((item) => Number(item.trim()))
				.filter((port) => Number.isInteger(port) && port > 0),
		),
	/** Values per service-scoped secret env file (e.g. edge function secrets). */
	APP_SERVICE_ENV_MAX_VARS: int(100),
	/**
	 * Statement timeout of a template's `on_rotate` SQL step, and the extra
	 * time allowed around it (SSH round trip, `docker exec`).
	 */
	APP_ROTATE_HOOK_TIMEOUT_MS: int(60_000),
	APP_ROTATE_HOOK_SLACK_MS: int(30_000),

	// Supabase plugin
	/** Edge function source limits (files per function, total bytes). */
	SUPABASE_FUNCTION_MAX_FILES: int(50),
	SUPABASE_FUNCTION_MAX_BYTES: int(1024 * 1024),
	/** Statement timeout and size of owner SQL run in the db container. */
	SUPABASE_SQL_TIMEOUT_MS: int(30_000),
	SUPABASE_SQL_MAX_BYTES: int(256 * 1024),
	/** Characters of an owner SQL text looked at for its audit entry. */
	SUPABASE_SQL_AUDIT_CHARS: int(2_000),
	/** Invoke tester / RPC runner (server-side HTTP through the app's API gateway). */
	SUPABASE_HTTP_TIMEOUT_MS: int(30_000),
	SUPABASE_HTTP_MAX_BODY_BYTES: int(256 * 1024),
	SUPABASE_HTTP_MAX_RESPONSE_BYTES: int(1024 * 1024),
	/** Extra time for the SSH round trip and `docker run` around a call or SQL run. */
	SUPABASE_EXEC_SLACK_MS: int(30_000),
	/** Storage file metadata check/repair: objects per batch, time per command. */
	SUPABASE_STORAGE_REPAIR_BATCH: int(1000),
	SUPABASE_STORAGE_REPAIR_TIMEOUT_MS: int(600_000),

	// Cloud sync (#/config/cloud-sync.ts): Supabase provider endpoints.
	/** Management API base (project, pooler settings, edge functions). */
	CLOUD_SYNC_SUPABASE_API_URL: z.url().default("https://api.supabase.com"),
	/** Hosted Storage S3 endpoint; `{ref}` = project reference. */
	CLOUD_SYNC_SUPABASE_S3_URL: z
		.string()
		.regex(/^https?:\/\/\S+$/)
		.default("https://{ref}.storage.supabase.co/storage/v1/s3"),
	/**
	 * PEM bundle of the Supabase root CAs the session pooler chains to
	 * (prod-ca-2021.crt + prod-ca-2025.crt from supabase/cli
	 * apps/cli-go/internal/gen/types/templates/), relative to the working
	 * directory (the image's /app). The pooler certificate is always
	 * verified (verify-full); without a certificate in it, nothing connects
	 * unless CLOUD_SYNC_ALLOW_UNVERIFIED_TLS is set.
	 */
	CLOUD_SYNC_SUPABASE_CA_FILE: z
		.string()
		.min(1)
		.default("certs/supabase-root-ca.pem"),
	/** Opt-in: without a CA, connect encrypted but unverified (warned). */
	CLOUD_SYNC_ALLOW_UNVERIFIED_TLS: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
	/**
	 * Hosts allowed on top of each provider's list (comma-separated, e.g. a
	 * test double); `*.suffix` matches subdomains.
	 */
	CLOUD_SYNC_EXTRA_ALLOWED_HOSTS: z.string().default("").transform(csv),
	/** Allow private addresses and plain http (test doubles only). */
	CLOUD_SYNC_ALLOW_PRIVATE: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
	/**
	 * Postgres client image per major (`major=image`, comma-separated) for
	 * dumps and loads, pinned to releases with the pg_dump `\restrict` fix
	 * (CVE-2025-8714: 17.6, 16.10, 15.14, 14.19, 13.22 and later).
	 */
	CLOUD_SYNC_PG_CLIENT_IMAGES: z
		.string()
		.default(
			"13=postgres:13.22-alpine,14=postgres:14.19-alpine,15=postgres:15.14-alpine,16=postgres:16.10-alpine,17=postgres:17.6-alpine,18=postgres:18.0-alpine",
		)
		.transform(majorImages),
	/**
	 * Docker network of the dump container (empty: Docker's default bridge,
	 * which reaches the internet).
	 */
	CLOUD_SYNC_DUMP_NETWORK: z
		.string()
		.regex(/^([a-z0-9][a-z0-9_.-]*)?$/)
		.default(""),
	CLOUD_SYNC_HTTP_TIMEOUT_MS: int(30_000),
	/** JSON responses of provider APIs. */
	CLOUD_SYNC_API_MAX_BYTES: int(4 * 1024 * 1024),
	/** One edge function download (multipart source files). */
	CLOUD_SYNC_FUNCTION_MAX_BYTES: int(16 * 1024 * 1024),
	/** Retries of a rate-limited (429) or failing (5xx) API call. */
	CLOUD_SYNC_API_RETRIES: int(3),
	/** Longest wait before a retry (Retry-After / rate limit reset). */
	CLOUD_SYNC_API_MAX_WAIT_MS: int(60_000),
	/** Queries the panel runs on the cloud database (tests, preflight). */
	CLOUD_SYNC_DB_TIMEOUT_MS: int(30_000),
	/** Upper bound of one import/export job. */
	CLOUD_SYNC_JOB_TIMEOUT_MS: int(6 * 60 * 60_000),
	/** Free disk needed on the target: (database + storage) × this. */
	CLOUD_SYNC_DISK_FACTOR: z.coerce.number().min(1).max(10).default(2.5),
	/** Parallel file transfers of the storage copy (rclone --transfers). */
	CLOUD_SYNC_RCLONE_TRANSFERS: int(4),
	/** Tables listed in the row count comparison of the summary. */
	CLOUD_SYNC_VERIFY_MAX_TABLES: int(500),
	/**
	 * Supabase import: pg_cron jobs re-created paused (default), as they
	 * were (`active`), or not at all (`skip`). An export asks in its modal.
	 */
	CLOUD_SYNC_CRON_JOBS: z.enum(CRON_JOB_MODES).default("paused"),
	/** Name prefix of cron jobs that had no name (`<prefix><jobid>`). */
	CLOUD_SYNC_CRON_UNNAMED_PREFIX: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,40}$/)
		.default("imported-job-"),
	/** Appwrite: items per list call while counting the cloud project. */
	CLOUD_SYNC_APPWRITE_PAGE_SIZE: int(100),
	/** Appwrite: list pages read per resource while counting (then estimated). */
	CLOUD_SYNC_APPWRITE_MAX_PAGES: int(20),
	/** Appwrite: tables whose rows are counted (one call each). */
	CLOUD_SYNC_APPWRITE_MAX_TABLES: int(500),
	/** Appwrite: `total` stops counting here (APP_LIMIT_COUNT): a lower bound. */
	CLOUD_SYNC_APPWRITE_COUNT_CAP: int(5000),
	/** Appwrite: the new app's API must answer within this after the deploy. */
	CLOUD_SYNC_APPWRITE_READY_TIMEOUT_MS: int(10 * 60_000),
	/** Appwrite: one request to the new app's API (curl container). */
	CLOUD_SYNC_APPWRITE_HTTP_TIMEOUT_MS: int(60_000),
	/** Appwrite: largest answer read from the new app's API. */
	CLOUD_SYNC_APPWRITE_MAX_RESPONSE_BYTES: int(4 * 1024 * 1024),
	/** Appwrite: how often the migration status is read. */
	CLOUD_SYNC_APPWRITE_POLL_MS: int(5_000),
	/** Appwrite: a migration still `pending` after this is reported stuck. */
	CLOUD_SYNC_APPWRITE_PENDING_TIMEOUT_MS: int(10 * 60_000),
	/** Appwrite: no counter change for this long while `processing`: stalled. */
	CLOUD_SYNC_APPWRITE_STALL_TIMEOUT_MS: int(30 * 60_000),
	/**
	 * Appwrite: the temporary migration key expires this long after the job
	 * timeout (it is deleted after the run; this bounds an orphan).
	 */
	CLOUD_SYNC_APPWRITE_KEY_TTL_SLACK_MS: int(30 * 60_000),
	/** Appwrite: migration errors written to the job log. */
	CLOUD_SYNC_APPWRITE_MAX_LOGGED_ERRORS: int(50),
	/**
	 * Export: schema the job creates in the cloud database for the storage
	 * owners while files upload (dropped afterwards).
	 */
	CLOUD_SYNC_EXPORT_STAGING_SCHEMA: z
		.string()
		.regex(/^[a-z_][a-z0-9_]{0,62}$/)
		.default("_nitrobase_export"),
	/** Export: largest `/health/version` answer read from the app's domain. */
	CLOUD_SYNC_EXPORT_HEALTH_MAX_BYTES: int(64 * 1024),
	/**
	 * Export: skip checking that the app answers on its public HTTPS
	 * address (test doubles only: the smoke's "cloud" reads the app on a
	 * private network).
	 */
	CLOUD_SYNC_EXPORT_SKIP_REACHABILITY: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),

	// Standalone databases (R3 M2)
	/** Console: statement timeout, rows shown, output read and input size per run. */
	DATABASE_CONSOLE_TIMEOUT_MS: int(15_000),
	DATABASE_CONSOLE_MAX_ROWS: int(500),
	DATABASE_CONSOLE_MAX_OUTPUT_BYTES: int(2 * 1024 * 1024),
	DATABASE_CONSOLE_MAX_INPUT_BYTES: int(64 * 1024),
	/** Error output kept per run (the rest is drained in the container). */
	DATABASE_CONSOLE_MAX_ERROR_BYTES: int(64 * 1024),
	/** Largest SCAN/HSCAN/SSCAN/ZSCAN COUNT the Valkey console accepts. */
	DATABASE_CONSOLE_SCAN_MAX_COUNT: int(1000),
	/** Console runs per member/token: at once, and per minute (one instance). */
	DATABASE_CONSOLE_CONCURRENCY: int(2),
	DATABASE_CONSOLE_RATE_PER_MINUTE: int(60),
	/** Users & databases statements (CREATE/DROP DATABASE can take a while). */
	DATABASE_ADMIN_TIMEOUT_MS: int(120_000),
	/** Extra time for the SSH round trip and `docker exec` around a run. */
	DATABASE_EXEC_SLACK_MS: int(15_000),
	/** How long a measured database size is reused by the list. */
	DATABASE_SIZE_CACHE_MS: int(5 * 60_000),
	/** One size probe (the list shows the last known size when it times out). */
	DATABASE_SIZE_TIMEOUT_MS: int(20_000),
	/** Length of passwords generated for users created from the UI. */
	DATABASE_USER_PASSWORD_LENGTH: int(32),

	// Backups
	/** rclone (uploads/downloads/destination tests), pinned. */
	RCLONE_IMAGE: z.string().min(1).default("rclone/rclone:1.71.1"),
	/** Base image of the per-server tools image (GNU tar + zstd + attr), pinned. */
	BACKUP_TOOLS_BASE_IMAGE: z.string().min(1).default("alpine:3.22"),
	/**
	 * Tag of the tools image built on each server from the base image
	 * (packages: #/config/backup-tools.ts). Bumped whenever the build
	 * changes: servers only build a tag they don't have yet.
	 */
	BACKUP_TOOLS_IMAGE: z
		.string()
		.regex(/^[a-z0-9][a-z0-9._/-]*:[\w.-]+$/)
		.default("nitrobase-backup-tools:2"),
	/** Root of the `local` destination driver on the server. */
	BACKUP_LOCAL_ROOT: z
		.string()
		.regex(/^\/[a-z0-9/_-]+[a-z0-9]$/, "must be an absolute path")
		.default("/var/backups/nitrobase"),
	BACKUP_ZSTD_LEVEL: z.coerce.number().int().min(1).max(19).default(6),
	/** Upper bound for one backup or restore job. */
	BACKUP_JOB_TIMEOUT_MS: int(6 * 60 * 60_000),
	/** Run a scheduled backup missed while Nitrobase was down, at boot. */
	BACKUP_CATCH_UP: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
	/** A scheduled run that finds the server busy waits at most this long. */
	BACKUP_BUSY_MAX_WAIT_MS: int(6 * 60 * 60_000),
	/** Absolute upper bound of one archive download. */
	BACKUP_DOWNLOAD_TIMEOUT_MS: int(6 * 60 * 60_000),
	/** A download is cut after this long with no bytes moving either way. */
	BACKUP_DOWNLOAD_IDLE_TIMEOUT_MS: int(5 * 60_000),
	/**
	 * Periodic removal of stale backup staging folders (a crashed panel can
	 * leave a 0600 rclone.conf behind) on every Ready server.
	 */
	BACKUP_WORK_SWEEP_CRON: z.string().min(1).default("41 * * * *"),
	/** How often a download checks for idleness. */
	BACKUP_DOWNLOAD_IDLE_CHECK_MS: int(10_000),
	/** Bytes buffered per download before reading from the server pauses. */
	BACKUP_DOWNLOAD_BUFFER_BYTES: int(8 * 1024 * 1024),
	/** Shortest allowed interval between two scheduled backups. */
	BACKUP_MIN_INTERVAL_MINUTES: int(60),
	/** PBKDF2 iterations of the self-backup encryption (openssl -iter). */
	SELF_BACKUP_PBKDF2_ITERATIONS: int(200_000),
	/** pg_dump used for the Nitrobase self-backup (must match the DB major). */
	SELF_BACKUP_PG_DUMP: z.string().min(1).default("pg_dump"),

	// Monitoring (single instance: collection loops run in-process)
	MONITORING_ENABLED: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
	/** Collection tick per Ready server (one remote command per tick). */
	MONITORING_INTERVAL_MS: int(15_000),
	/** Random delay before a server's first tick (spreads loops started together). */
	MONITORING_START_JITTER_MS: int(2_000),
	/** Timeout of one collection command (`docker stats` samples ~2s). */
	MONITORING_COMMAND_TIMEOUT_MS: int(20_000),
	/** Error backoff: interval doubles per failure up to this. */
	MONITORING_BACKOFF_MAX_MS: int(5 * 60_000),
	/** Start/stop loops as servers become Ready or not (croner, seconds allowed). */
	MONITORING_RECONCILE_CRON: z.string().min(1).default("*/30 * * * * *"),
	/** Live samples kept in memory per server for new SSE subscribers. */
	MONITORING_LIVE_POINTS: int(60),
	/** Concurrent monitoring SSE streams per user. */
	MONITORING_STREAMS_PER_USER: int(6),
	/** Buffered sample rows are written at least this often. */
	MONITORING_FLUSH_INTERVAL_MS: int(30_000),
	/** ...or as soon as this many rows are buffered. */
	MONITORING_FLUSH_BATCH_SIZE: int(500),
	/**
	 * Filesystem types that are not real disks (df). `overlay` is not here:
	 * Docker's overlay mounts are dropped by mount prefix, while a
	 * containerized host's root may itself be overlay.
	 */
	MONITORING_PSEUDO_FS: z
		.string()
		.default(
			"tmpfs,devtmpfs,squashfs,proc,sysfs,cgroup,cgroup2,devpts,mqueue,nsfs,fuse.lxcfs,efivarfs,autofs,tracefs,debugfs,securityfs,pstore,bpf,configfs,ramfs,hugetlbfs,shm,nullfs,iso9660",
		)
		.transform(csv),
	/** Mount points under these prefixes are skipped (container/bind internals). */
	MONITORING_IGNORE_MOUNT_PREFIXES: z
		.string()
		.default("/var/lib/docker/,/run/,/snap/,/sys/,/proc/,/dev/")
		.transform(csv),
	/**
	 * Exact mount points never reported: single files Docker bind-mounts into
	 * a container (Nitrobase or a Docker-in-Docker host sees them in df).
	 */
	MONITORING_IGNORE_MOUNTS: z
		.string()
		.default("/etc/hosts,/etc/hostname,/etc/resolv.conf")
		.transform(csv),
	/** Network interfaces counted as host traffic exclude these prefixes. */
	MONITORING_IGNORE_NET_PREFIXES: z
		.string()
		.default("lo,veth,docker,br-,virbr,cni,flannel,cali,vxlan,kube,tunl")
		.transform(csv),
	/** Raw samples are kept this long, then only rollups. */
	METRICS_RAW_RETENTION_HOURS: int(24),
	/** Rollup bucket size and how long rollups are kept. */
	METRICS_ROLLUP_BUCKET_MINUTES: int(5),
	METRICS_ROLLUP_RETENTION_DAYS: int(7),
	/** Each rollup run re-aggregates this much recent history (late rows). */
	METRICS_ROLLUP_LOOKBACK_MINUTES: int(30),
	METRICS_ROLLUP_CRON: z.string().min(1).default("*/5 * * * *"),
	METRICS_RETENTION_CRON: z.string().min(1).default("17 * * * *"),
	/** Points per history chart series (bins are widened to fit). */
	METRICS_CHART_POINTS: int(240),

	// Alerts (rules: #/server/services/monitoring/alert-rules.ts)
	ALERT_DISK_PERCENT: percent(85),
	ALERT_MEMORY_PERCENT: percent(90),
	/** A threshold alert resolves only below threshold minus this. */
	ALERT_HYSTERESIS_PERCENT: z.coerce.number().min(0).max(50).default(5),
	/** Restart loop: this many restarts within the window. */
	ALERT_RESTART_LOOP_COUNT: int(3),
	ALERT_RESTART_LOOP_WINDOW_MINUTES: int(10),
	/** Consecutive failed ticks before a server counts as unreachable. */
	ALERT_UNREACHABLE_FAILURES: int(3),
	/**
	 * Proxy network self-heal (apps/networks.ts): a container needing the
	 * same repair on more consecutive monitoring ticks than this is left
	 * alone and raises a `network_flap` alert instead.
	 */
	NETWORK_REPAIR_MAX_ATTEMPTS: int(3),

	// Notifications (channels: #/config/notification-channels.ts)
	/** One HTTP/SMTP send attempt. */
	NOTIFY_TIMEOUT_MS: int(10_000),
	/** Attempts per delivery (first + retries), backoff doubles from the base. */
	NOTIFY_MAX_ATTEMPTS: int(4),
	NOTIFY_RETRY_BASE_MS: int(5_000),
	/** Same event + subject on one channel within this window is sent once. */
	NOTIFY_DEDUPE_WINDOW_MS: int(30 * 60_000),
	/** At most this many deliveries per channel per window (alert storms). */
	NOTIFY_RATE_LIMIT: int(30),
	NOTIFY_RATE_WINDOW_MS: int(60 * 60_000),
	NOTIFY_DELIVERY_RETENTION_DAYS: int(30),
	/** Locale of notification texts: one of the app's `locales`. */
	NOTIFY_LOCALE: z
		.enum(locales.map((locale) => locale.code) as [Locale, ...Locale[]])
		.default(defaultLocale),
	/** Telegram Bot API base (override only for tests/proxies). */
	TELEGRAM_API_URL: z.url().default(TELEGRAM_DEFAULT_API_URL),
	/** Scheduled certificate scan of every domain (expiry/errors → events). */
	CERT_SCAN_CRON: z.string().min(1).default("23 6 * * *"),
	/** "No successful backup in N days" check of enabled schedules. */
	BACKUP_STALE_DAYS: int(2),
	BACKUP_STALE_CRON: z.string().min(1).default("37 7 * * *"),

	// Audit log
	AUDIT_RETENTION_DAYS: int(365),
	/**
	 * Finished jobs (deployments + their logs, every kind) older than this
	 * are deleted by the platform retention schedule.
	 */
	JOB_RETENTION_DAYS: int(90),
	AUDIT_PAGE_SIZE: int(50),
	AUDIT_EXPORT_MAX_ROWS: int(50_000),
	/** Retention jobs of audit, deliveries and old sessions. */
	PLATFORM_RETENTION_CRON: z.string().min(1).default("51 3 * * *"),

	/**
	 * Use X-Forwarded-For / X-Real-IP for client addresses (audit, rate
	 * limits). Only when every request comes through a trusted proxy
	 * (e.g. Traefik with the panel domain), else they can be forged.
	 */
	TRUST_PROXY: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
	/**
	 * Proxies in front of the panel that append to X-Forwarded-For (Traefik:
	 * 1). The client address is that many entries from the RIGHT; anything
	 * further left was sent by the client and is ignored.
	 */
	TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(1),

	// Instance identity (split-brain guard, see instance-state.ts)
	/** This panel's identity; when set it wins over the marker file. */
	INSTANCE_ID: z
		.string()
		.regex(/^[A-Za-z0-9_-]{8,128}$/)
		.optional(),
	/** Marker file holding this panel's identity (keep it on a volume). */
	INSTANCE_MARKER_FILE: z.string().min(1).default(".data/instance-id"),

	// Teams, invites and API tokens
	/** Who may create additional teams: instance admins only, or every account. */
	TEAM_CREATION: z.enum(["admins", "everyone"]).default("admins"),
	/** Lifetime of a team invite link. */
	INVITE_TTL_HOURS: int(72),
	/** Upper bound of an API token's lifetime (days); tokens may not be unlimited beyond it. */
	API_TOKEN_MAX_TTL_DAYS: int(365),
	/** `/api/v1` requests per token (or per client IP before auth) per window. */
	API_RATE_LIMIT: int(120),
	API_RATE_WINDOW_MS: int(60_000),
	/** last_used_at of a token is written at most this often. */
	API_TOKEN_TOUCH_INTERVAL_MS: int(60_000),

	// Cloudflare Tunnel (per server, token-based; no Cloudflare API calls)
	CLOUDFLARED_IMAGE: z
		.string()
		.min(1)
		.default("cloudflare/cloudflared:2025.9.1"),
	CLOUDFLARED_CONTAINER: z
		.string()
		.regex(name)
		.default("nitrobase-cloudflared"),
	/** Tunnel connector status probe (inspect + readiness check). */
	TUNNEL_STATUS_TIMEOUT_MS: int(30_000),
	/** cloudflared metrics/readiness port inside nitrobase-network (`/ready`). */
	CLOUDFLARED_METRICS_PORT: z.coerce
		.number()
		.int()
		.min(1)
		.max(65535)
		.default(20241),

	// Sessions and 2FA
	/** lastSeen of a session is written at most this often. */
	SESSION_TOUCH_INTERVAL_MS: int(5 * 60_000),
	/** Revoked/expired session rows are kept this long (new-device checks, UI). */
	SESSION_RETENTION_DAYS: int(90),
	/**
	 * Long-lived connections (terminal WebSockets, SSE streams) re-check
	 * their session this often (backstop for expiry and deleted users;
	 * revocations close them immediately).
	 */
	SESSION_REVALIDATE_INTERVAL_MS: int(30_000),
	/** Time between password and 2FA code at login. */
	TWO_FACTOR_PENDING_TTL_MS: int(5 * 60_000),
	/** TOTP steps accepted before/after now (clock drift). */
	TOTP_WINDOW: z.coerce.number().int().min(0).max(3).default(1),
	TOTP_ISSUER: z.string().min(1).max(64).default(APP_NAME),
	TWO_FACTOR_RECOVERY_CODES: int(10),

	// Login hardening (in-process limiter: single instance)
	LOGIN_RATE_PER_IP: int(20),
	/** Failed sign-ins per (account, client IP) per window. */
	LOGIN_RATE_PER_ACCOUNT: int(8),
	LOGIN_RATE_WINDOW_MS: int(15 * 60_000),
	TWO_FACTOR_RATE_PER_USER: int(6),
	TWO_FACTOR_RATE_WINDOW_MS: int(15 * 60_000),
	/** Removes stored sign-in/2FA counters whose window is over. */
	RATE_LIMIT_PRUNE_CRON: z.string().min(1).default("*/15 * * * *"),

	// Releases and in-panel upgrade (R4 M3)
	/**
	 * `owner/name` of the Nitrobase repository whose releases are checked
	 * (GitHub, or a Gitea/Forgejo host with RELEASE_API_URL). Unset or
	 * empty: the official releases (RELEASE_REPO_DEFAULT), so installs made
	 * by the script and by hand both see updates; forks set their own.
	 * UPDATE_CHECK_ENABLED=false turns the check off.
	 */
	RELEASE_REPO: z.preprocess(
		(value) =>
			typeof value === "string" && value.trim() === "" ? undefined : value,
		z
			.string()
			.trim()
			.regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/name")
			.default(RELEASE_REPO_DEFAULT),
	),
	/** Releases API base (GitHub API by default; Gitea: https://host/api/v1). */
	RELEASE_API_URL: z
		.url()
		.optional()
		.or(z.literal("").transform(() => undefined)),
	/** "stable" ignores pre-releases; "prerelease" offers them too. */
	RELEASE_CHANNEL: z.enum(["stable", "prerelease"]).default("stable"),
	/** Off-switch of the Nitrobase update check. */
	UPDATE_CHECK_ENABLED: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
	UPDATE_CHECK_CRON: z.string().min(1).default("23 */6 * * *"),
	/** How long a release list is reused before asking the API again. */
	UPDATE_CHECK_CACHE_MS: int(6 * 60 * 60_000),
	/**
	 * The updater: a short-lived container (Docker CLI + compose) started
	 * through the host's Docker socket. It swaps the panel image, waits for
	 * health and rolls back to the previous image on failure.
	 */
	UPDATER_IMAGE: z.string().min(1).default("docker:28.5.1-cli"),
	UPDATER_CONTAINER: z.string().regex(name).default("nitrobase-updater"),
	DOCKER_SOCKET: z
		.string()
		.regex(/^\/[\w./-]+$/)
		.default("/var/run/docker.sock"),
	/** The new panel must be healthy within this, else the old image returns. */
	UPGRADE_HEALTH_TIMEOUT_SECONDS: int(300),
	/** The updater checks the panel container this often (seconds). */
	UPGRADE_HEALTH_POLL_SECONDS: int(3),
	/** Panel log lines the updater shows when a version fails. */
	UPGRADE_LOG_TAIL_LINES: int(40),
	/** Pulling the new panel image (and the updater image). */
	UPGRADE_PULL_TIMEOUT_MS: int(20 * 60_000),
	/** How long the new panel follows a running updater before giving up. */
	UPGRADE_FOLLOW_TIMEOUT_MS: int(20 * 60_000),
	/** How often a running upgrade's updater container is polled. */
	UPGRADE_POLL_MS: int(2_000),
	/** One `docker inspect`/`docker logs` call against the host. */
	UPGRADE_HOST_COMMAND_TIMEOUT_MS: int(30_000),
	/** Removing the finished updater container. */
	UPGRADE_CLEANUP_TIMEOUT_MS: int(60_000),
	/** Web host of GitHub repositories (release notes, README links). */
	GITHUB_WEB_URL: z.url().default("https://github.com"),
	/** Section of the repository README with the install guide. */
	DOCS_INSTALL_ANCHOR: z.string().default("#install-on-a-vps"),
	/** "Install on a VPS" guide (default: the repository README, else /install.sh). */
	DOCS_INSTALL_URL: z
		.url()
		.optional()
		.or(z.literal("").transform(() => undefined)),
	/**
	 * One-time token needed for the first sign-up and the first-run restore
	 * while no account exists (the installer generates and prints it).
	 * Unset: anyone reaching a fresh panel first may set it up (warned).
	 */
	SETUP_TOKEN: z
		.string()
		.trim()
		.min(16, "must be at least 16 characters")
		.optional()
		.or(z.literal("").transform(() => undefined)),
	/** First-run "Restore Nitrobase from a self-backup": largest upload. */
	FIRST_RUN_RESTORE_MAX_BYTES: int(256 * 1024 * 1024),
	/** Largest unpacked archive (decompression bombs stop here). */
	FIRST_RUN_RESTORE_MAX_EXPANDED_BYTES: int(2 * 1024 * 1024 * 1024),
	/** Longest single SQL statement of a restored dump (DDL; COPY data is streamed). */
	FIRST_RUN_RESTORE_MAX_STATEMENT_BYTES: int(1024 * 1024),
	/** Shortest accepted ENCRYPTION_KEY (same rule as the instance's own). */
	FIRST_RUN_RESTORE_KEY_MIN_LENGTH: int(32),
	/**
	 * NOSUPERUSER role the restored dump runs as (created on demand): COPY
	 * … PROGRAM, untrusted languages, ALTER SYSTEM or roles fail whatever
	 * the dump contains.
	 */
	FIRST_RUN_RESTORE_ROLE: z.string().regex(name).default("nitrobase_restore"),
	/** Loading the restored dump (psql). */
	FIRST_RUN_RESTORE_TIMEOUT_MS: int(30 * 60_000),
	/** Restore attempts per client address per window (unauthenticated). */
	FIRST_RUN_RESTORE_RATE_LIMIT: int(10),
	FIRST_RUN_RESTORE_RATE_WINDOW_MS: int(15 * 60_000),
	/** psql used to load a restored dump (same major as the DB, like pg_dump). */
	FIRST_RUN_RESTORE_PSQL: z.string().min(1).default("psql"),

	// App updates (R4 M4)
	/** Scheduled check of every app whose source has versions. */
	APP_UPDATE_CHECK_ENABLED: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
	APP_UPDATE_CHECK_CRON: z.string().min(1).default("41 */6 * * *"),
	/** Git apps: ask the remote for the branch tip (runs git on the server). */
	APP_UPDATE_CHECK_GIT: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
	/** Concurrent checks (each may call GitHub or a server). */
	APP_UPDATE_CHECK_CONCURRENCY: int(4),
	/**
	 * Maintenance window of automatic updates (apps with an auto policy):
	 * starts at this cron time, new updates start only within the window.
	 */
	APP_AUTO_UPDATE_CRON: z.string().min(1).default("0 3 * * *"),
	APP_AUTO_UPDATE_WINDOW_MINUTES: int(120),
	/** A queued update waits at most this long for its server. */
	APP_UPDATE_QUEUE_MAX_WAIT_MS: int(60 * 60_000),
	/** A queued update retries starting (server busy) this often. */
	APP_UPDATE_RETRY_MS: int(5_000),
	/** How often a queued update checks whether its job has ended. */
	APP_UPDATE_JOB_POLL_MS: int(2_000),
	/** Apps per bulk update. */
	APP_UPDATE_BATCH_MAX: int(50),
	/** Finished bulk update summaries kept in memory. */
	APP_UPDATE_BATCHES_KEPT: int(20),

	// Panel (Settings → Instance → Panel domain)
	/**
	 * Public URL of the panel (`https://panel.example.com`): absolute links
	 * in notifications and invites, the API document's server. Read through
	 * `appBaseUrl()`; unset or not an http(s) URL: no absolute links.
	 */
	APP_URL: z.string().trim().optional(),
	PANEL_CONTAINER: z.string().regex(name).default("nitrobase_app"),
	PANEL_PORT: int(3000),
	/** Private network shared only by Traefik and the panel container. */
	PANEL_NETWORK: z.string().regex(name).default("nitrobase-panel"),
	/**
	 * Installer --domain: a panel route job started right after a bootstrap
	 * waits for the server's lock this many times, this long apart.
	 */
	PANEL_ROUTE_RETRIES: int(20),
	PANEL_ROUTE_RETRY_MS: int(3_000),

	// Misc
	ACME_EMAIL: emailSchema()
		.optional()
		.or(z.literal("").transform(() => undefined)),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | null = null;

/** Parse the configuration. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const parsed = ConfigSchema.safeParse(env);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("\n- ");
		throw internalError(`Invalid configuration:\n- ${issues}`);
	}
	return parsed.data;
}

export function getConfig(): AppConfig {
	cached ??= loadConfig();
	return cached;
}

/** Derived host paths (all under NITROBASE_ROOT). */
export function hostPaths(config: AppConfig = getConfig()) {
	const root = config.NITROBASE_ROOT;
	return {
		root,
		apps: `${root}/apps`,
		logs: `${root}/logs`,
		traefik: `${root}/traefik`,
		traefikStatic: `${root}/traefik/traefik.yml`,
		traefikDynamic: `${root}/traefik/dynamic`,
		traefikMiddlewares: `${root}/traefik/dynamic/middlewares.yml`,
		acmeDir: `${root}/traefik/acme`,
		acmeFile: `${root}/traefik/acme/acme.json`,
		/** Staging for backup/restore archives (removed after each job). */
		backupWork: `${root}/backup-work`,
		/** Wizard repository checks (throwaway clones, removed after). */
		gitInspect: `${root}/git-inspect`,
		/** cloudflared's env file (TUNNEL_TOKEN), 0600. */
		tunnelEnv: `${root}/tunnel/cloudflared.env`,
	};
}

/** APP_URL without a trailing slash (null: unset or not an http(s) URL). */
export function appBaseUrl(config: AppConfig = getConfig()): string | null {
	if (!config.APP_URL) return null;
	try {
		const url = new URL(config.APP_URL);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

/** Version label shown in the UI, e.g. "v3.6.25" from "traefik:v3.6.25". */
export function traefikVersion(config: AppConfig = getConfig()): string {
	const tag = config.TRAEFIK_IMAGE.split(":").pop() ?? "";
	return tag && tag !== config.TRAEFIK_IMAGE ? tag : "latest";
}

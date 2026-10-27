# App templates

Each directory here is one template. Adding a template = adding a directory; nothing else needs to change.

```text
templates/<id>/
  template.toml        # required: metadata, version source, variables, domains, security allowlist
  docker-compose.yml   # optional: used when `source.path` is not set
  overlay.yml          # optional: deep-merged onto the (upstream) compose before the transform
  logo.svg             # optional
  ...                  # other files next to the compose file are copied into the app folder
```

Every template also needs an offline test fixture (see "Testing" below).

`<id>` must match `id` in `template.toml` and `^[a-z0-9-]+$`.

## template.toml

```toml
id = "pocketbase"
name = "PocketBase"
description = "…"
category = "backend"            # marketplace category (labels: src/config/template-categories.ts)
# color = "teal"                # optional: Mantine palette colour tinting the app icon in lists
#                               # (default: the source kind's colour, src/config/app-sources.ts;
#                               # the source kind's icon also stands in when logo.svg is missing)
website = "https://pocketbase.io"
docs = "https://pocketbase.io/docs/"   # self-hosting docs, linked from the marketplace
tags = ["database"]             # lowercase slugs; filterable in the marketplace
min_docker_version = "20.10"    # optional: checked by the deploy pre-flight
advanced = false                # true: "Advanced" badge + explicit confirmation in the wizard
notes = "Register the owner account right away."  # optional: shown after deploying
limitation = "Functions are disabled in this template."  # optional: marketplace card + app page
# data_binds = ["data/settings.json"]  # bind sources the app creates itself at runtime
#                               # (exempt from the file checks, see "Bind mounts of files")
# no_default_restart = ["init"] # services left without a restart policy (see "Compose rules")

[source]
# type = "github"               # "github" (default) | "inline" (custom compose: the owner pastes it)
repo = "pocketbase/pocketbase"  # GitHub owner/repo
versions = "releases"           # "releases" | "tags" | "commits" | "branches" (e.g. v3.2.1 branches)
# ref = "main"                  # branch for "commits" mode
# version_prefix = "v"          # stripped for ${version_number} (e.g. "n8n@" for n8n@1.2.3)
# sort = "published"            # "published" (GitHub order) | "version" (numeric, newest first)
# path = "docker"               # fetch this repo directory at the chosen version ("." = repo root,
#                               # then list `include`: only those paths are listed and fetched)
# compose = "docker-compose.yml"   # compose file (in `path`, or this template dir)
# env_defaults = ".env.example" # upstream defaults (in `path`), overridden by [variables]
# include = ["docker-compose.yml", "volumes"]  # only fetch these files/dirs from `path`
#                               # (an entry `{ path = "x.sh", min_version = "2.4.0" }` is
#                               # fetched only from that version on, see "Bind mounts")
# version_filter = '^v\d+\.\d+\.\d+$'          # versions offered (regex on the ref)
# min_version = "v1.26.07"      # oldest version offered (named versions only), see below

[variables.PB_ADMIN_PASSWORD]
value = "${password:24}"        # expression, see below
description = "…"
secret = true                   # masked everywhere; revealed only on request (audited)
credential = true               # shown in the app's credentials panel
editable = true                 # user may override at deploy time
# initial_only = true          # only read on the app's first start (e.g. an admin account the
#                               # app creates once, then manages itself): after the first
#                               # successful deploy the value is frozen (read-only in the env
#                               # editor, kept on re-renders), the credentials panel labels it
#                               # "Initial value" and a restore takes it from the data.
#                               # Not combinable with `rotatable`.
type = "string"                 # string | email | url | hostname | integer | boolean (a switch in the form)
min_length = 10                 # optional: also max_length, pattern (regex)
group = "Admin"                 # optional: deploy form section heading
rotatable = true                # generated values only: "Rotate" regenerates it (and dependents) + redeploys
# prefill = "account_email"     # deploy form default from the signed-in user (e.g. the admin email)
# permission = "app.terminal"   # team permission also needed to set it (deploy form, env editor):
#                               # for values that load code (src/config/permissions.ts ids)

# Optional step offered after a successful rotation (rotatable variables only),
# e.g. sign every user out when the secret that signs their tokens changes.
# [variables.PB_ADMIN_PASSWORD.on_rotate]
# label = "Sign out all users"  # checkbox in the rotate dialog (template text)
# description = "…"             # shown while ticked; skipped = "…" while unticked
# default = true                # ticked by default
# service = "db"                # compose service whose container runs psql
# user = "postgres"             # database role the SQL runs as
# database = "postgres"
# sql = "delete from sessions;" # plain SQL, no psql meta-commands (\…)
# `on_rotate.sql` runs as the given database role (often a superuser) on the
# owner's server, so anyone reviewing a template must check that SQL.

[[domains]]
service = "pocketbase"          # compose service Traefik routes to
port = 8090                     # container port
primary = true                  # gets the app's domain; others get <service>.<domain>
https = true                    # default
# path_prefix = "/api"
# subdomain = "console"         # secondary host label (default: the service name); needed when
#                               # one service is routed on several ports
# root_redirect = "/console/"   # GET / redirects here (e.g. a UI mounted under a path)
# paths = [{ prefix = "/v1", service = "api", port = 80 }]
#   path routes on the same host(s) to other services (longest prefix wins)
# basic_auth = { username = "ADMIN_USER", password = "ADMIN_PASSWORD" }
#   Traefik basic-auth middleware (bcrypt) on every domain routed to this
#   service, with credentials from these variables (the file is written 0600).
# extra_domains = { policy = "warn", reason = "Sign-in only works on the primary domain." }
#   additional domains the owner adds on this service and port: "warn" adds
#   them and shows the reason (Domains tab, after adding, "Limited" badge),
#   "refuse" refuses them; the primary domain is never limited. The reason
#   is English template text (extracted for translation).

[[links]]                       # optional quick links on the app page
label = "Admin console"         # button text (English; extracted for translation)
path = "/_/"                    # path on the domain (default "/")
# service = "studio"            # routed service whose domain is used (default: the primary domain)
# primary = true                # the main "Open" button (default: "Open app" on the primary domain)

[resources.pocketbase]          # optional default limits per service (owners can override per app)
memory_mb = 512                 # hard memory limit (MiB) → deploy.resources.limits.memory
# memory_reservation_mb = 128   # soft reservation (MiB)
# cpus = 1.0                    # CPU limit (cores) → deploy.resources.limits.cpus
#   Applied without Swarm (docker compose honours deploy.resources). A server can
#   require limits on every service (server Settings → Resource limits).

[[ports]]                       # optional, opt-in: owner may publish this port on the host
id = "db"                       # unique slug
service = "db"
port = 5432                     # container port
label = "Postgres"
description = "psql from outside"
default_host_port = 5432        # suggested; the owner picks the host port (>= 1024)

[health]                        # optional readiness check after `up`
service = "pocketbase"          # defaults to the primary domain's service
path = "/api/health"            # HTTP probe from the proxy network; any status < 500 passes
port = 8090
timeout_seconds = 300           # default: APP_HEALTH_TIMEOUT_MS
# stable_seconds = 20           # every service ready, with no restart, this long (and over
#                               # APP_READY_STABLE_SAMPLES samples) before the deploy counts it as up;
#                               # default: APP_READY_STABLE_MS
# restart_limit = 6             # restarts of one service, counted once every service has been up at once,
#                               # that fail the deploy (APP_RESTART_LOOP); before that 3× this
#                               # (first-boot dependency retries). Default: APP_DEPLOY_RESTART_LIMIT
# expect = [200, 401]           # statuses that count as healthy (default: any < 500)

[security]                      # everything here defaults to off/empty
# reason = "Why it needs this"  # required when anything is allowed: shown as a warning in the
#                               # marketplace, the preview and the wizard (which asks the owner
#                               # to confirm before deploying)
# privileged = false
# host_network = false
# host_pid = false
# docker_socket = false
# cap_add = []
# devices = []
# security_opt = []
# host_paths = []               # absolute host paths allowed as bind mounts
# external = []                 # external volumes/networks allowed

[backup]                        # what a full backup contains (see "Backups" below)
paths = ["pb_data"]             # bind folders inside the app folder
# volumes = ["db-config"]       # compose named volumes
stop = true                     # stop services while archiving: true | false | ["svc"]
# reset = ["volumes/db/data"]   # bind folders emptied before a dump is restored (fresh init)
# reset_volumes = ["db-data"]   # named volumes emptied before a dump is restored
# [backup.database]             # generic dump strategy (src/server/services/backup/db-strategies.ts)
# type = "postgres"             # postgres | mysql | mariadb | sqlite
# service = "db"
# mode = "database"             # postgres: "cluster" (roles + all DBs) | "database" (one DB)
# user = "app"                  # postgres: superuser (local socket); mysql: user + password_env
# database = "app"              # postgres: the database (created on restore when missing)
# strict = false                # postgres "database" mode / mysql: fail on the first SQL error
#                               # (one transaction). Default: errors are counted, the restore job
#                               # finishes with warnings (badge on the job)
# legacy_ids = []               # older strategy ids whose archives this one restores
# (or `database = "db"`: the provider plugin's own strategy)
# [[backup.hooks]]              # docker exec around the backup
# when = "pre"                  # pre | post
# service = "app"
# command = ["sh", "-c", "app flush"]

[[rewrites]]                    # optional, opt-in: literal substitution in a copied file, applied
path = "volumes/functions/main/index.ts"   # only while the `when` variable is non-empty
find = "'jsr:"                  # literal text (every occurrence)
replace = "'${FUNCTIONS_JSR_MIRROR}/"      # may reference template variables; their values are
when = "FUNCTIONS_JSR_MIRROR"   # limited to URL characters (no quotes, spaces, backslashes, `$`)
#   Entries for the same file and variable are alternatives (e.g. both quote styles): a
#   "has no effect" warning is logged only when none of them matched. Not for the compose or
#   env defaults file (use an overlay).

[failure_hints.jsr_unreachable] # optional: the workaround named when a deploy finds this known
variable = "FUNCTIONS_JSR_MIRROR"  # failure in a crash-looping service's logs (signatures:
#                               # src/config/failure-signatures.ts); must be an editable variable

[plugin]                        # settings for the template's provider plugin (see src/plugins)
```

Top-level `service_env = ["functions"]` gives those services a Nitrobase-managed secret env file (`service-env/<service>.env`, mode 0600, values encrypted in the database and never shown again). Provider plugins use it (e.g. Supabase edge function secrets); names the compose `environment:` of that service already sets are refused, since they would win.

### Localisation

Templates are written in **English only**. Translatable fields are `name`, `description`, `notes`, `limitation`, `[security].reason`, the variables' `label`, `description` and `group`, and the ports' `label` and `description`.

`bun run i18n:extract` collects them into the Lingui catalogs through the template extractor (`scripts/lingui/template-extractor.ts`): the English text is the message id, with a note such as "template supabase: variable SMTP_HOST label". Translate them in `src/locales/<locale>.json` like any other message, then run `bun run i18n:compile`. The UI translates them with `translateTemplateText` (`src/libs/i18n.ts`).

Texts are plain text: the schema refuses `{` and `}` in them (the English text is a Lingui ICU message id, so braces would be read as placeholders). Per-locale tables (`i18n.vi = { … }`) are rejected by the template schema, so adding a language never requires editing a template. Changing an English text creates a new id: translate it again. A test fails when a shipped template has texts missing from the catalog (run the extractor).

### Published ports

Compose `ports` are always removed. Ports declared in `[[ports]]` are off by default; the owner enables them per app (Settings → Published ports, with an exposure warning). The compose policy then allows exactly those `host:container/tcp` mappings on all interfaces, and rejects any other `ports` entry, also in the resolved model. Reserved host ports (`APP_RESERVED_HOST_PORTS`), ports used by other apps on the server and ports already listening are refused.

### Provider plugins

Template-specific UI and server actions live in a provider plugin registered in `src/plugins/registry.ts` (capabilities + lazy app-page tabs). The plugin reads its settings from `[plugin]`, validated by its own schema.

### Versions

- `releases`: GitHub releases (with dates, pre-releases flagged; drafts hidden).
- `tags`: git tags (no dates).
- `commits`: latest commits on `ref` touching `path`.

The default is the newest version that matches `version_filter` and is not a pre-release. `source.min_version` (releases, tags or branches; compared numerically like the other `min_version` keys) hides older versions from the picker, the default and update checks, and a render of an older version is refused (`TEMPLATE_VERSION_NOT_OFFERED`); a redeploy of the commit an app already runs is not. Use it for upstream releases that cannot be deployed, e.g. ones whose compose uses a setting the policy blocks (a policy refusal of an upstream version's compose reads "pick a newer version"). The deploy wizard's pre-flight dry-renders the chosen version and inputs, so such a refusal shows before Deploy. At deploy time the chosen ref is resolved **once** to a commit SHA, and every file is fetched at that SHA (stored on the app so redeploys are reproducible).

Files under `path` are fetched through the Git Trees API (one tree per path segment, then the directory recursively), downloaded at the commit SHA, verified against their git blob SHA and cached by blob SHA. Symlinks are skipped, submodules rejected, and file count/size limits (`TEMPLATE_EXTRACT_MAX_FILES`, `TEMPLATE_EXTRACT_MAX_BYTES`) are enforced before and after download.

### Updates

Nitrobase checks every app's source on a schedule (`APP_UPDATE_CHECK_CRON`) and shows "Update available" when a newer stable version exists (newest matching `version_filter`; `commits` sources: a newer commit). A one-click update backs up first (default on), changes the version like "Change version", and when the deploy or the health check fails it rolls back as the template says:

```toml
[updates]
rollback = "redeploy"   # default: deploy the previous version again (data untouched)
# rollback = "restore"  # restore the backup taken before the update (new versions migrate data irreversibly)
# rollback = "manual"   # leave the app for the owner (logged and notified)
```

With `restore`, an update without a backup rolls back nothing (`manual`): redeploying an old version onto migrated data could break it. Automatic updates (per-app policy: patch or minor releases, in the maintenance window `APP_AUTO_UPDATE_CRON` + `APP_AUTO_UPDATE_WINDOW_MINUTES`) always back up first; versions that do not parse as semver are never applied automatically.

### Variable expressions

Values are templates; `${…}` is evaluated, `$$` is a literal `$`.

| Expression | Result |
|---|---|
| `${password:N}` | N random alphanumeric characters |
| `${base64:N}` | N random bytes, base64 |
| `${hex:N}` | N random bytes, hex (2N characters) |
| `${uuid}` | random UUID |
| `${jwt:SECRET_VAR:role[:issuer]}` | HS256 JWT `{role, iss?, iat, exp: +10y}` signed with variable `SECRET_VAR` (`iss` only when an issuer is given) |
| `${bcrypt:VAR[:cost]}` | bcrypt hash of variable `VAR` (default cost 10), e.g. a pre-hashed admin password; regenerated when `VAR` changes |
| `${opaque_key:PREFIX:NAMESPACE}` | checksummed opaque API key `PREFIX` + 22 random base64url characters + `_` + 8-character checksum (first 8 base64url characters of SHA-256 of `NAMESPACE\|PREFIX<random>`), the format of Supabase's `sb_publishable_…` / `sb_secret_…` keys |
| `${signing_keys:es256[:SECRET_VAR]}` | JSON array of signing JWKs: a new ES256 (P-256) key pair with a random `kid` (`use: sig`, `key_ops: [sign, verify]`), plus variable `SECRET_VAR` as a symmetric HS256 JWK (`kty: oct`) when given; regenerated when `SECRET_VAR` changes |
| `${jwks:KEYS_VAR}` | verification key set `{"keys": […]}` of the signing keys in `KEYS_VAR`: private parts removed, `key_ops: [verify]`; symmetric keys are kept, so mark it `secret` when `KEYS_VAR` has one |
| `${jwt_es256:KEYS_VAR:role[:issuer]}` | ES256 JWT `{role, iss?, iat, exp: +10y}` signed with the first ES256 private key in `KEYS_VAR` (header carries its `kid`) |
| `${OTHER_VAR}` | value of another variable |
| `${domain}` `${url}` | app domain, `https://<domain>` |
| `${version}` `${version_number}` | chosen ref, ref without `source.version_prefix` (default `v`) |
| `${app_id}` `${app_name}` `${folder}` | app identifiers |

Variables resolve in declaration order with dependencies first; cycles and unknown references are errors. Values from a previous deployment are kept on redeploy so secrets are not regenerated. A generated variable whose previous value is empty (e.g. a key upstream's `.env.example` shipped empty before the template started generating it) is generated on the next deploy; nothing else changes.

`min_version = "v1.26.04"` on a variable defines it only when the deployed upstream version is at least that one (numeric comparison of the version name); older versions keep upstream's own default, if any. Use it for settings of a feature upstream introduced in a given release.

All variables are written to the app's `.env` file (always quoted) and reach containers only through compose interpolation (`${VAR}` in the compose file). They are never interpolated into shell commands.

### Compose rules

Compose files (especially ones fetched from GitHub) are untrusted. Nitrobase rewrites them before deploying:

- project name = app folder (`<id>-<8 chars of app id>`); `container_name` = `<folder>-<service>`, the original name kept as a network alias inside the app;
- published `ports` are removed (traffic goes through Traefik);
- no service names a shared network (the proxy network, database link networks): Compose would register the *service* name there too, so two apps with a service named `kong` would resolve each other's containers. Services listed in `[[domains]]` (labelled `nitrobase.routed`) and the services of a database link are attached after every `up`/`start` with `docker network connect`, under their container name only (`.nitrobase-networks` in the app folder lists them); service names resolve only on the app's private default network. Templates must address other apps' services by container name, never by service name;
- labels `nitrobase.app` and `nitrobase.service` are added;
- a service that declares no restart policy (`restart:` or `deploy.restart_policy`) gets `APP_DEFAULT_RESTART` (`unless-stopped`; `none` turns it off), so the whole app comes back after a reboot of its host. Explicit values are kept (`restart: "no"` keeps a service stopped), and so are one-shot jobs another service waits on (`depends_on: { x: { condition: service_completed_successfully } }`) and the services listed in `no_default_restart`. A one-shot job nothing waits on must be listed there (or declare `restart: "no"`), or it would run again and again;
- relative bind mounts, `env_file` and build contexts are pinned inside the app folder (`..` escapes are rejected);
- explicit `name:` of volumes/networks/configs/secrets is prefixed with the folder;
- `traefik.*` and `com.docker.*` labels are removed (routing comes only from Nitrobase-generated files);
- bind mounts of the app folder itself, of Nitrobase's own files (`.env`, `custom.env`, `service-env/`, `docker-compose.yml`), and of any host path that contains the app folder (even if allowlisted) are always rejected, also as a volume `driver_opts.device`;
- rejected unless allowed in `[security]`: `privileged`, `network_mode: host`, `pid/ipc/uts/userns_mode: host`, `cap_add`, `devices`, `security_opt`, the Docker socket, host paths outside the app folder, external resources;
- always rejected: `container:` namespaces of other apps (in-app ones become `service:`), `network_mode: bridge`, `device_cgroup_rules`, `cgroup_parent`, `runtime`, `sysctls`, `isolation`, `oom_kill_disable`, `use_api_socket`, `provider`, `external_links`, `include`, remote build contexts, build `ssh`/`entitlements`/host network, and any `$` interpolation in security-relevant fields.

The same policy runs again at deploy time on `docker compose config --format json` (the fully interpolated model), and every bind source inside the app folder is checked on the host to not traverse a symlink.

### Bind mounts of files

Docker creates a missing bind source as an empty **directory**, so a file the
compose bind-mounts (`./clickhouse-init.sh:/docker-entrypoint-initdb.d/…`) that
the deploy did not write turns into a folder and the service crash-loops
("Is a directory"). Every bind source inside the app folder must therefore be
one of:

- a file the deploy writes (fetched upstream, the template's own, or rendered);
- a folder holding such files (config the deploy writes);
- a data folder that may start empty (e.g. `./volumes/db/data`, `./pb_data`):
  created empty before `up`;
- runtime data the template declares: `data_binds` (files or folders the
  app creates or fills itself), `[backup] paths` and `reset`. These are
  never checked.

```toml
data_binds = ["data/settings.json"]   # created by the app at runtime
```

Checks:

- **at render** (fetched templates), hard: a bind source that is not
  written and not declared but exists upstream as a *file* at the pinned
  commit is refused with `TEMPLATE_BIND_SOURCE_MISSING` (the template's
  `include` misses it). The upstream listing is only fetched when such a
  source is named like a file (below);
- **before and after `up`**, hard: a bind source the deploy writes must be
  a regular file (never created as a folder);
- **name-based**, soft (every source kind, incl. custom compose): a bind
  source nothing writes and nothing declares, named like a file (an
  extension such as `.sh`, `.xml`, `.conf`, `.json`, `.yml`, see
  `src/config/bind-files.ts`; database/state extensions are deliberately
  not listed) is never created as a folder. Before `up` a missing one only
  logs a warning (the owner may put the file on the server, e.g. a custom
  compose `./config.json`), and the deploy goes on; after `up`, if it is an
  empty folder (Docker created it), the deploy fails with
  `TEMPLATE_BIND_SOURCE_MISSING`. A folder the app filled counts as data.
  Custom compose apps declare such paths in the wizard ("Files the app
  creates itself", spec `dataBinds`).

An empty folder Docker left where a file now gets written (an earlier deploy
mounted it before it was fetched) is removed before the files are written.

When upstream adds a bind-mounted file in a release, include it from that
release on, so older releases (without the file) still fetch:

```toml
include = [
  "docker-compose.yml",
  { path = "clickhouse-init.sh", min_version = "2.4.0" },
]
```

`min_version` compares version names (like variables and overlays), so it
needs named versions (`source.versions` other than `commits`). Any other
missing `include` entry fails the fetch.

### Compose overlay

`overlay.yml` in the template directory is deep-merged onto the compose file
(fetched upstream or local) before the transform: mappings merge key by key,
lists and scalars replace, and `null` removes a key, e.g.

```yaml
services:
  traefik: null                 # drop upstream's own proxy
  db:
    environment: ["POSTGRES_PASSWORD=${DB_PASSWORD}"]   # replace a demo password
```

The merged result goes through the same transform and policy as any compose
file: an overlay cannot add anything the policy refuses.

Version-gated overlays are merged after `overlay.yml`, in order, only for
upstream versions at least `min_version` (e.g. settings upstream ships
commented out from a given release on):

```toml
[[overlays]]
path = "overlay-api-keys.yml"
min_version = "v1.26.04"
```

### Custom compose (inline templates)

`source.type = "inline"` (template `custom-compose`) has no versions and
fetches nothing: each app stores the owner's compose file, env, routed
service/port(s) and backup volumes, encrypted (`apps.custom_spec_encrypted`).
The compose is analysed and checked by the policy in the wizard, rendered
with the same transform at every deploy, and can be edited from the app's
Settings (diff preview, save or save and redeploy). `[security]` stays empty
for it. Backups archive the chosen named volumes with the app stopped.

### Databases (`source.type = "database"`)

Template `database` backs every standalone database (Data → Databases).
The engine and its pinned image tag are the app's version
(`postgres@18.6`), so backups, restores, clones and moves carry them. The
compose file, variables (generated password, user, database), container
health check, `[backup.database]` strategy (`postgres` cluster, `mysql`,
`mariadb`, `redis` RDB, `mongodb` archive), default memory limit and the
optional published port come from the engine registry
(`src/config/database-engines.ts` for names/versions,
`src/server/services/databases/engines.ts` for the rest). Nothing is
routed; the default network is `internal` unless the port is published.
Apps reach a database through a per-link network (`nitrobase-link-<id>`,
reserved: no compose file declares it, the containers are attached by
name after `up`, so the database's `db` never collides with a linked app's
own `db`).

## Testing

`src/server/services/templates/shipped-templates.test.ts` renders every
template offline and runs the transform and policy, checks that routes,
health, backup volumes, the dump strategy and ports name things that exist,
that every `${VAR}` the compose reads is defined, and snapshots the result
(`__snapshots__/templates/<id>.*`). Each template needs
`src/server/services/templates/__fixtures__/templates/<id>/meta.json`
(`{ "version": "…" }`), plus `upstream/` with the fetched files when it uses
`source.path`, or `spec.json` for an inline template. Update the snapshots
with `bunx vitest run -u` after reviewing the diff.

## Deploy layout on the server

```text
/etc/nitrobase/apps/<folder>/          # template files, docker-compose.yml, .env (0600), app data
/etc/nitrobase/traefik/dynamic/app-<key>.yml   # routes (flat: Traefik does not watch subdirectories)
```

## Shipped templates

- **appwrite**: releases (2.x). Appwrite's installer renders the repo's own `docker-compose.yml` at the release tag; Nitrobase fetches it plus `.env` (development defaults; every value that differs in production is set in template.toml) and the MongoDB init files, and `overlay.yml` removes Traefik, MariaDB, the optional/"separate" services and the **Functions/Sites executor and orchestrator**: both mount the Docker socket (root on the host) and start runtime containers outside the app's compose project and the policy, so a per-template allowlist cannot contain them. Appwrite therefore runs without Functions and Sites builds. One host: console on `/`, API under `/v1`, realtime under `/v1/realtime` (`paths`).
- **n8n**: releases `n8n@X.Y.Z` (2.x+, sorted by version), official image, Postgres; the owner account is managed from env (`N8N_INSTANCE_OWNER_*`, bcrypt hash generated from the owner password), encryption key generated and shown as a credential.
- **umami**: releases (v3+), Postgres; a one-shot sidecar replaces Umami's default `admin`/`umami` password with a generated one right after the first start.
- **plausible**: Plausible CE version branches (`v3.2.1`…), official `compose.yml` + ClickHouse tuning files from the repo root; `overlay.yml` replaces the demo database password.
- **rustfs**: S3-compatible object storage (Apache-2.0; MinIO images can no longer be pulled), S3 API on the app domain, console on `console.<domain>`.
- **custom-compose**: your own compose file (advanced), see above.

- **pocketbase**: versions from `pocketbase/pocketbase` releases (v0.23+). The compose file builds a small Alpine image from the official release zip, verified against the release `checksums.txt`, so no third-party image is trusted. A superuser is upserted from `PB_ADMIN_EMAIL`/`PB_ADMIN_PASSWORD` on start.
- **supabase**: versions from `supabase/supabase` releases (`v1.YY.MM`, monthly, each pinning a tested set of images). Files come from the repo's `docker/` directory at the release commit; upstream `.env.example` supplies defaults and every insecure demo secret is overridden with generated values (`ANON_KEY`/`SERVICE_ROLE_KEY` are JWTs signed with the generated `JWT_SECRET`). From v1.26.04 the new API keys are generated as upstream's `utils/add-new-auth-keys.sh` does (`SUPABASE_PUBLISHABLE_KEY`/`SUPABASE_SECRET_KEY`, `JWT_KEYS`/`JWT_JWKS` with an ES256 key pair plus the legacy secret, and the ES256 `ANON_KEY_ASYMMETRIC`/`SERVICE_ROLE_KEY_ASYMMETRIC` Kong forwards for them), and `overlay-api-keys.yml` enables the services' asymmetric verification (upstream ships it commented out); the legacy keys keep working.

## Backups

A full backup is a `.tar.zst` built on the app's server and uploaded with rclone to a destination (`src/config/backup-drivers.ts`: server folder, S3-compatible, Cloudflare R2, Backblaze B2). It contains:

- `manifest.json`: app, template version and commit SHA, and the sha256 and size of every member;
- `env.enc`: the app's env (and service secrets), encrypted with the instance `ENCRYPTION_KEY`;
- `compose/docker-compose.yml`: the deployed compose file;
- `db/<file>`: the provider plugin's database dump (e.g. Supabase `pg_dumpall`), if `database` is set;
- `files/<n>.tar` and `volumes/<n>.tar`: the `paths` and `volumes`.

Member tars are read and written by a throwaway tools container (no network, no `MKNOD`), never through host paths of volumes. `stop` keeps copies consistent (SQLite needs it); a template whose database is dumped online can use `stop = false`. With both `stop` and `database`, the order is: pre hooks, stop the services in the stop set except the dumped database service, dump the database (still running), stop the database if it is in the set, copy the paths and volumes, start again exactly the services the backup stopped. The dump and the copies then hold the same writes. Only running services are stopped (a service the owner stopped stays stopped), a service stops before the services it `depends_on` (ties keep the `stop` list order) and they start again in reverse.

A restore downloads the archive, checks its sha256, validates the archive listing (regular files and known members only), checks every member against the manifest, then redeploys the app at the backed-up commit and loads the volumes and the dump before the services start. "Restore as a new app" does the same into a new app with its own folder and domains.

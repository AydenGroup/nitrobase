#!/usr/bin/env bash
# Nitrobase installer for a fresh Ubuntu/Debian VPS (idempotent).
#
#   curl -fsSL <installer-url> | sudo bash -s -- --repo <owner>/<name>
#
# What it does: checks the machine (root, OS, CPU, RAM, disk, ports),
# installs Docker from Docker's official apt repository when missing,
# creates the install folder (default /opt/nitrobase) with a 0600 .env holding
# generated secrets, downloads docker-compose.prod.yml of the chosen
# release, starts Nitrobase and waits until it is healthy.
#
# Running it again keeps the secrets and data: it updates the compose file
# and the options you pass (e.g. --version to move to another release).
#
# Options (all optional except --repo when no release source is known):
#   --version <v>       Release to install (default: latest release, or the
#                       version already installed).
#   --dir <path>        Install folder (default /opt/nitrobase).
#   --panel-bind <a>    Host address:port of the panel (default
#                       0.0.0.0:3000; 127.0.0.1:3000 with --domain).
#   --domain <host>     Panel domain: HTTPS through Traefik + Let's Encrypt,
#                       applied once you bootstrap Localhost in the panel.
#   --repo <o/n>        Repository whose releases are installed (env
#                       NITROBASE_REPO).
#   --image <name>      Panel image without tag (default ghcr.io/<repo>).
#   --api-url <url>     Releases API (default https://api.github.com; Gitea or
#                       Forgejo: https://host/api/v1).
#   --raw-url <url>     Base URL of raw files at a tag (default
#                       https://raw.githubusercontent.com/<repo>).
#   --compose-url <u>   Exact URL of docker-compose.prod.yml to use.
#   --yes               Do not ask before installing Docker.
#   --uninstall         Stop and remove the containers; data and .env stay.
#   --purge             With --uninstall: also delete the data volumes and
#                       the install folder (asks you to type a confirmation).
#   --print-config      Print the resolved settings and exit (no changes).
#   -h, --help          This help.
set -Eeuo pipefail

# --- Defaults (the only place installer settings live) -------------------------
readonly PRODUCT_NAME="Nitrobase"                              # = APP_NAME (src/config/shared.ts)
# Each setting below can be overridden by the option shown, or by the
# NITROBASE_* variable.
readonly DEFAULT_DIR="${NITROBASE_INSTALL_PARENT:-/opt}/nitrobase" # --dir (parent: tests only)
readonly DEFAULT_PANEL_BIND="0.0.0.0:3000"                     # --panel-bind
readonly DEFAULT_PANEL_BIND_WITH_DOMAIN="127.0.0.1:3000"       # --panel-bind with --domain
readonly DEFAULT_API_URL="https://api.github.com"              # --api-url
readonly DEFAULT_RAW_BASE="https://raw.githubusercontent.com"  # --raw-url = <base>/<repo>
readonly DEFAULT_IMAGE_REGISTRY="ghcr.io"                      # --image = <registry>/<repo>
readonly DOCKER_APT_URL="https://download.docker.com/linux"    # Docker's official apt repository
readonly DOCKER_PACKAGES="docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
readonly COMPOSE_PROJECT="nitrobase"                           # docker compose project name
readonly APP_CONTAINER="nitrobase_app"                         # container_name of the panel
readonly UPDATER_CONTAINER="nitrobase-updater"                 # in-panel upgrade helper
readonly TRAEFIK_PORTS="80 443"                                # warned about when busy
readonly MIN_RAM_MB=1800                                       # warning below
readonly MIN_DISK_MB=5000                                      # refused below
readonly HEALTH_TIMEOUT="${NITROBASE_HEALTH_TIMEOUT:-300}"     # seconds
readonly HEALTH_POLL_SECONDS=3
readonly SETUP_TOKEN_LENGTH=32                                 # hex characters
# Overridable for tests only.
readonly OS_RELEASE_FILE="${NITROBASE_OS_RELEASE:-/etc/os-release}"
readonly MEMINFO_FILE="${NITROBASE_MEMINFO:-/proc/meminfo}"
readonly APT_ETC="${NITROBASE_APT_ETC:-/etc/apt}"
# -------------------------------------------------------------------------------

VERSION=""
DIR=""
PANEL_BIND=""
DOMAIN=""
REPO="${NITROBASE_REPO:-}"
IMAGE="${NITROBASE_IMAGE:-}"
API_URL="${NITROBASE_API_URL:-$DEFAULT_API_URL}"
RAW_URL="${NITROBASE_RAW_URL:-}"
COMPOSE_URL="${NITROBASE_COMPOSE_URL:-}"
ASSUME_YES=0
UNINSTALL=0
PURGE=0
PRINT_CONFIG=0

say() { printf '%s\n' "$*"; }
info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

usage() {
	sed -n '2,/^set -Eeuo/p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed -e '$d' -e 's/^# \{0,1\}//' ||
		say "Usage: install.sh [--version v] [--dir path] [--panel-bind addr:port] [--domain host] [--repo owner/name] [--uninstall [--purge]]"
}

need_value() {
	if [ "$#" -lt 2 ] || [ -z "$2" ] || [ "${2#--}" != "$2" ]; then
		die "$1 needs a value"
	fi
}

parse_args() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
		--version)
			need_value "$@"
			VERSION="${2#v}"
			shift 2
			;;
		--dir)
			need_value "$@"
			DIR="$2"
			shift 2
			;;
		--panel-bind)
			need_value "$@"
			PANEL_BIND="$2"
			shift 2
			;;
		--domain)
			need_value "$@"
			DOMAIN="$2"
			shift 2
			;;
		--repo)
			need_value "$@"
			REPO="$2"
			shift 2
			;;
		--image)
			need_value "$@"
			IMAGE="$2"
			shift 2
			;;
		--api-url)
			need_value "$@"
			API_URL="$2"
			shift 2
			;;
		--raw-url)
			need_value "$@"
			RAW_URL="$2"
			shift 2
			;;
		--compose-url)
			need_value "$@"
			COMPOSE_URL="$2"
			shift 2
			;;
		--yes | -y)
			ASSUME_YES=1
			shift
			;;
		--uninstall)
			UNINSTALL=1
			shift
			;;
		--purge)
			PURGE=1
			shift
			;;
		--print-config)
			PRINT_CONFIG=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*) die "unknown option: $1 (see --help)" ;;
		esac
	done
}

# Image tag rules; also applied to versions read from .env or the releases API.
validate_version() {
	[[ "$1" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$ ]] || die "invalid version from $2: $1"
}

validate_args() {
	DIR="${DIR:-$DEFAULT_DIR}"
	case "$DIR" in
	/*) ;;
	*) die "--dir must be an absolute path" ;;
	esac
	[ "$DIR" != "/" ] || die "--dir cannot be /"
	[[ "$DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--dir may only contain letters, digits, . _ - /"
	if [ -n "$VERSION" ]; then validate_version "$VERSION" "--version"; fi
	if [ -n "$DOMAIN" ]; then
		DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
		[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$ ]] || die "invalid --domain: $DOMAIN"
	fi
	if [ -z "$PANEL_BIND" ]; then
		# Behind the panel domain, plain HTTP stays on the loopback only.
		if [ -n "$DOMAIN" ]; then PANEL_BIND="$DEFAULT_PANEL_BIND_WITH_DOMAIN"; else PANEL_BIND="$DEFAULT_PANEL_BIND"; fi
	fi
	[[ "$PANEL_BIND" =~ ^([0-9]{1,3}(\.[0-9]{1,3}){3}|\[[0-9a-fA-F:]+\]):[0-9]{1,5}$ ]] || die "invalid --panel-bind (address:port): $PANEL_BIND"
	if [ -n "$REPO" ]; then
		[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid --repo (owner/name): $REPO"
	fi
	if [ -z "$IMAGE" ] && [ -n "$REPO" ]; then
		IMAGE="$DEFAULT_IMAGE_REGISTRY/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"
	fi
	if [ -n "$IMAGE" ]; then
		[[ "$IMAGE" =~ ^[a-z0-9][a-z0-9._/:-]*[a-z0-9]$ ]] || die "invalid --image: $IMAGE"
	fi
	API_URL="${API_URL%/}"
	if [ -z "$RAW_URL" ] && [ -n "$REPO" ]; then RAW_URL="$DEFAULT_RAW_BASE/$REPO"; fi
	RAW_URL="${RAW_URL%/}"
	if [ "$PURGE" = 1 ] && [ "$UNINSTALL" = 0 ]; then die "--purge only goes with --uninstall"; fi
}

print_config() {
	say "dir=$DIR"
	say "version=${VERSION:-latest}"
	say "panel_bind=$PANEL_BIND"
	say "domain=$DOMAIN"
	say "repo=$REPO"
	say "image=$IMAGE"
	say "api_url=$API_URL"
	say "raw_url=$RAW_URL"
	say "compose_url=$COMPOSE_URL"
	say "uninstall=$UNINSTALL"
	say "purge=$PURGE"
}

# --- checks -----------------------------------------------------------------

check_root() {
	[ "$(id -u)" = "0" ] || die "run as root (sudo bash install.sh ...)"
}

check_os() {
	[ -r "$OS_RELEASE_FILE" ] || die "cannot read $OS_RELEASE_FILE: only Ubuntu and Debian are supported"
	local id="" like=""
	id="$(sed -n 's/^ID=//p' "$OS_RELEASE_FILE" | tr -d '"')"
	like="$(sed -n 's/^ID_LIKE=//p' "$OS_RELEASE_FILE" | tr -d '"')"
	case "$id" in
	ubuntu | debian) OS_ID="$id" ;;
	*)
		case " $like " in
		*" debian "* | *" ubuntu "*) OS_ID="debian" ;;
		*) die "unsupported OS '$id': use Ubuntu or Debian" ;;
		esac
		;;
	esac
	OS_CODENAME="$(sed -n 's/^VERSION_CODENAME=//p' "$OS_RELEASE_FILE" | tr -d '"')"
}

check_arch() {
	case "$(uname -m)" in
	x86_64 | amd64 | aarch64 | arm64) ;;
	*) die "unsupported CPU architecture $(uname -m): amd64 or arm64 only" ;;
	esac
}

check_resources() {
	local mem_kb=0 disk_kb=0 parent
	mem_kb="$(awk '/^MemTotal:/ {print $2}' "$MEMINFO_FILE" 2>/dev/null || echo 0)"
	if [ "${mem_kb:-0}" -lt $((MIN_RAM_MB * 1024)) ]; then
		warn "only $((mem_kb / 1024)) MB of RAM: $PRODUCT_NAME plus a few apps want 2 GB or more"
	fi
	parent="$DIR"
	while [ ! -d "$parent" ]; do parent="$(dirname "$parent")"; done
	disk_kb="$(df -Pk "$parent" | awk 'NR==2 {print $4}')"
	if [ "${disk_kb:-0}" -lt $((MIN_DISK_MB * 1024)) ]; then
		die "only $((disk_kb / 1024)) MB free on $parent: at least $MIN_DISK_MB MB needed"
	fi
}

port_in_use() {
	command -v ss >/dev/null 2>&1 || return 1
	ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
}

check_ports() {
	local port="${PANEL_BIND##*:}"
	if port_in_use "$port" && ! container_exists; then
		die "port $port is already in use (choose another with --panel-bind)"
	fi
	for p in $TRAEFIK_PORTS; do
		if port_in_use "$p"; then
			warn "port $p is in use: Traefik (installed when you bootstrap a server) needs ports $TRAEFIK_PORTS"
		fi
	done
}

container_exists() {
	command -v docker >/dev/null 2>&1 && docker inspect "$APP_CONTAINER" >/dev/null 2>&1
}

# --- docker -------------------------------------------------------------------

# A terminal to ask on (curl | bash has none on stdin; CI has none at all).
has_tty() {
	(: </dev/tty) 2>/dev/null
}

confirm() {
	[ "$ASSUME_YES" = 1 ] && return 0
	local answer=""
	if has_tty; then
		printf '%s [y/N] ' "$1" >/dev/tty
		read -r answer </dev/tty || true
	else
		die "$1 Re-run with --yes to confirm non-interactively."
	fi
	case "$answer" in y | Y | yes | YES) return 0 ;; *) die "aborted" ;; esac
}

install_docker() {
	if command -v docker >/dev/null 2>&1; then
		if docker compose version >/dev/null 2>&1; then
			info "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') with compose is installed"
			return
		fi
		info "Installing the Docker compose plugin..."
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-plugin >/dev/null ||
			die "could not install docker-compose-plugin: install Docker Compose v2 yourself"
		return
	fi
	confirm "Docker is not installed. Install it from Docker's official repository?"
	info "Installing Docker from $DOCKER_APT_URL..."
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq >/dev/null
	apt-get install -y -qq ca-certificates curl >/dev/null
	install -m 0755 -d "$APT_ETC/keyrings" "$APT_ETC/sources.list.d"
	curl -fsSL "$DOCKER_APT_URL/$OS_ID/gpg" -o "$APT_ETC/keyrings/docker.asc"
	chmod a+r "$APT_ETC/keyrings/docker.asc"
	[ -n "$OS_CODENAME" ] || die "VERSION_CODENAME missing in $OS_RELEASE_FILE"
	printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] %s/%s %s stable\n' \
		"$(dpkg --print-architecture)" "$DOCKER_APT_URL" "$OS_ID" "$OS_CODENAME" >"$APT_ETC/sources.list.d/docker.list"
	apt-get update -qq >/dev/null
	# shellcheck disable=SC2086 # a word list
	apt-get install -y -qq $DOCKER_PACKAGES >/dev/null
	if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
	docker compose version >/dev/null 2>&1 || die "Docker was installed but 'docker compose' does not work"
}

# --- release & files ----------------------------------------------------------

latest_version() {
	[ -n "$REPO" ] || die "no --version given and no --repo to look up the latest release"
	local json tag
	json="$(curl -fsSL -H 'Accept: application/json' "$API_URL/repos/$REPO/releases/latest")" ||
		die "could not read the latest release of $REPO from $API_URL"
	tag="$(printf '%s' "$json" | tr ',' '\n' | sed -n 's/^[[:space:]{]*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
	[ -n "$tag" ] || die "the latest release of $REPO has no tag"
	printf '%s' "${tag#v}"
}

env_get() {
	[ -f "$DIR/.env" ] || return 0
	sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1 | tr -d '"'
}

# Set KEY=value in .env (replace or append) without echoing the value.
env_set() {
	local key="$1" value="$2" tmp
	tmp="$(mktemp "$DIR/.env.XXXXXX")"
	chmod 600 "$tmp"
	if [ -f "$DIR/.env" ]; then grep -v "^$key=" "$DIR/.env" >"$tmp" || true; fi
	printf '%s=%s\n' "$key" "$value" >>"$tmp"
	mv -f "$tmp" "$DIR/.env"
}

random_hex() {
	od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
}

write_env() {
	local created=0 name
	umask 077
	mkdir -p "$DIR"
	chmod 700 "$DIR"
	if [ ! -f "$DIR/.env" ]; then
		: >"$DIR/.env"
		created=1
	fi
	chmod 600 "$DIR/.env"
	for name in ENCRYPTION_KEY SESSION_SECRET POSTGRES_PASSWORD; do
		if [ -z "$(env_get "$name")" ]; then env_set "$name" "$(random_hex)"; fi
	done
	# One-time token for the first account (or the first-run restore): only
	# whoever ran this installer can set up the panel.
	if [ -z "$(env_get SETUP_TOKEN)" ]; then env_set SETUP_TOKEN "$(random_hex | cut -c1-"$SETUP_TOKEN_LENGTH")"; fi
	env_set NITROBASE_IMAGE "$IMAGE"
	env_set NITROBASE_VERSION "$VERSION"
	env_set PANEL_BIND "$PANEL_BIND"
	if [ -n "$REPO" ]; then env_set RELEASE_REPO "$REPO"; fi
	if [ "$API_URL" != "$DEFAULT_API_URL" ]; then env_set RELEASE_API_URL "$API_URL"; fi
	if [ -n "$DOMAIN" ]; then
		env_set PANEL_DOMAIN "$DOMAIN"
		env_set APP_URL "https://$DOMAIN"
		# Only Traefik (and SSH tunnels) reach a loopback-bound panel.
		case "$PANEL_BIND" in 127.0.0.1:* | \[::1\]:*) env_set TRUST_PROXY true ;; esac
	fi
	SECRETS_CREATED="$created"
	# Shown now as well: a later step may fail before the summary.
	if [ "$created" = 1 ]; then secrets_notice; fi
}

secrets_notice() {
	say ""
	say "  !! Back up the secrets in $DIR/.env now, somewhere other than this server:"
	say "  !!   ENCRYPTION_KEY, SESSION_SECRET, POSTGRES_PASSWORD"
	say "  !! Without ENCRYPTION_KEY no backup of this panel can be restored."
	say "  !! Show them with: sudo grep -E '^(ENCRYPTION_KEY|SESSION_SECRET|POSTGRES_PASSWORD)=' $DIR/.env"
	say ""
}

download_compose() {
	local target="$DIR/docker-compose.yml" tmp url
	tmp="$(mktemp "$DIR/compose.XXXXXX")"
	if [ -n "$COMPOSE_URL" ]; then
		curl -fsSL "$COMPOSE_URL" -o "$tmp" || die "could not download $COMPOSE_URL"
	else
		[ -n "$RAW_URL" ] || die "no --repo or --compose-url: cannot download docker-compose.prod.yml"
		for ref in "v$VERSION" "$VERSION"; do
			url="$RAW_URL/$ref/docker-compose.prod.yml"
			if curl -fsSL "$url" -o "$tmp" 2>/dev/null; then break; fi
			url=""
		done
		[ -n "$url" ] || die "docker-compose.prod.yml of $VERSION not found under $RAW_URL"
	fi
	grep -q "container_name: $APP_CONTAINER" "$tmp" || die "the downloaded file is not $PRODUCT_NAME's docker-compose.prod.yml"
	chmod 644 "$tmp"
	mv -f "$tmp" "$target"
}

compose() {
	docker compose --project-directory "$DIR" --project-name "$COMPOSE_PROJECT" -f "$DIR/docker-compose.yml" "$@"
}

wait_healthy() {
	local deadline status
	deadline=$(($(date +%s) + HEALTH_TIMEOUT))
	info "Waiting for $PRODUCT_NAME to become healthy (migrations run first)..."
	while [ "$(date +%s)" -lt "$deadline" ]; do
		status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$APP_CONTAINER" 2>/dev/null || true)"
		case "$status" in
		healthy) return 0 ;;
		unhealthy | exited | dead) break ;;
		esac
		sleep "$HEALTH_POLL_SECONDS"
	done
	docker logs --tail 30 "$APP_CONTAINER" 2>&1 | sed 's/^/  | /' >&2 || true
	die "$PRODUCT_NAME did not become healthy (status: ${status:-unknown}). Logs above; fix and re-run this installer."
}

panel_url() {
	local host="${PANEL_BIND%:*}" port="${PANEL_BIND##*:}" ip=""
	case "$host" in
	0.0.0.0)
		ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
		printf 'http://%s:%s' "${ip:-<server-ip>}" "$port"
		;;
	*) printf 'http://%s:%s' "$host" "$port" ;;
	esac
}

print_summary() {
	local port="${PANEL_BIND##*:}"
	say ""
	info "$PRODUCT_NAME $VERSION is running."
	if [ "$SECRETS_CREATED" = 1 ]; then secrets_notice; fi
	say ""
	say "Next steps:"
	case "$PANEL_BIND" in
	127.0.0.1:* | \[::1\]:*)
		say "  1. Open an SSH tunnel from your computer:  ssh -L $port:127.0.0.1:$port root@<server-ip>"
		say "     then browse http://localhost:$port"
		;;
	*)
		say "  1. Open $(panel_url) (plain HTTP: sign up from a trusted network or an SSH tunnel)"
		;;
	esac
	say "  2. Create the administrator account (the first account), or restore a $PRODUCT_NAME self-backup there."
	say "     Setup token (asked once, until the first account exists): $(env_get SETUP_TOKEN)"
	say "  3. Follow the Getting started checklist: bootstrap Localhost or add a VPS, deploy an app, add backups."
	if [ -n "$DOMAIN" ]; then
		say "  4. Point $DOMAIN (A/AAAA record) at this server. Once Localhost is bootstrapped, the panel is"
		say "     served at https://$DOMAIN automatically (Let's Encrypt)."
	fi
	say ""
	say "Upgrade later from Settings → Instance, or re-run this installer with --version <v>."
}

# --- uninstall ----------------------------------------------------------------

uninstall() {
	# Only a folder this installer set up (its compose file names the panel).
	if ! grep -qs "container_name: $APP_CONTAINER" "$DIR/docker-compose.yml"; then
		die "no $PRODUCT_NAME install in $DIR (no docker-compose.yml naming $APP_CONTAINER)"
	fi
	if [ "$PURGE" = 1 ]; then
		local typed=""
		say "This deletes the $PRODUCT_NAME database, the panel data and $DIR (apps on your servers are not touched)."
		if [ -n "${NITROBASE_PURGE_CONFIRM:-}" ]; then
			typed="$NITROBASE_PURGE_CONFIRM"
		elif has_tty; then
			printf 'Type "purge %s" to confirm: ' "$DIR" >/dev/tty
			read -r typed </dev/tty || true
		fi
		[ "$typed" = "purge $DIR" ] || die "not confirmed: nothing was deleted"
		docker rm -f "$UPDATER_CONTAINER" >/dev/null 2>&1 || true
		compose down --volumes --remove-orphans
		rm -rf -- "$DIR"
		info "$PRODUCT_NAME and its data were removed."
	else
		docker rm -f "$UPDATER_CONTAINER" >/dev/null 2>&1 || true
		compose down --remove-orphans
		info "$PRODUCT_NAME was stopped and removed. Data volumes and $DIR/.env were kept; run the installer again to start it."
	fi
}

main() {
	parse_args "$@"
	validate_args
	if [ "$PRINT_CONFIG" = 1 ]; then
		print_config
		exit 0
	fi
	check_root
	if [ "$UNINSTALL" = 1 ]; then
		uninstall
		exit 0
	fi
	check_os
	check_arch
	check_resources
	install_docker
	check_ports
	if [ -z "$VERSION" ]; then
		VERSION="$(env_get NITROBASE_VERSION)"
		if [ -n "$VERSION" ]; then validate_version "$VERSION" "$DIR/.env"; fi
	fi
	if [ -z "$VERSION" ]; then
		VERSION="$(latest_version)"
		validate_version "$VERSION" "the latest release"
	fi
	if [ -z "$IMAGE" ]; then IMAGE="$(env_get NITROBASE_IMAGE)"; fi
	[ -n "$IMAGE" ] || die "no --image or --repo: which image should run?"
	[[ "$IMAGE" =~ ^[a-z0-9][a-z0-9._/:-]*[a-z0-9]$ ]] || die "invalid image: $IMAGE"
	info "Installing $PRODUCT_NAME $VERSION ($IMAGE) in $DIR"
	write_env
	download_compose
	compose config --quiet || die "docker compose rejected $DIR/docker-compose.yml"
	info "Pulling images..."
	# A locally loaded image (air-gapped install) is fine: `up` reports a
	# missing one.
	compose pull --quiet --ignore-pull-failures || true
	compose up -d --remove-orphans || die "could not start $PRODUCT_NAME (is $IMAGE:$VERSION available?)"
	wait_healthy
	print_summary
}

OS_ID=""
OS_CODENAME=""
SECRETS_CREATED=0
main "$@"

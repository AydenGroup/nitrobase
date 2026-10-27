#!/usr/bin/env bash
# Nitrobase installer for a fresh Ubuntu/Debian VPS (idempotent).
#
#   curl -fsSL https://nitrobase.app/install.sh | sudo bash
#   curl -fsSL https://nitrobase.app/install.sh | sudo bash -s -- --domain panel.example.com
#
# What it does: checks the machine (root, OS, CPU, RAM, disk, ports),
# installs Docker from Docker's official apt repository when missing,
# creates the install folder (default /opt/nitrobase) with a 0600 .env holding
# generated secrets, downloads docker-compose.prod.yml of the chosen
# release, starts Nitrobase and waits until it is healthy.
#
# Running it again keeps the secrets and data: it updates the compose file
# and the options you pass (e.g. --version to move to another release).
# Without --repo / --image / --api-url / --panel-bind, a re-run keeps the
# ones in .env (RELEASE_REPO, NITROBASE_IMAGE, RELEASE_API_URL, PANEL_BIND),
# else the defaults.
#
# In a container (the installer image, NITROBASE_INSTALLER_CONTAINER=1):
#
#   docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock \
#     -v /opt/nitrobase:/opt/nitrobase ghcr.io/aydengroup/nitrobase-installer
#
# the same install is made through the mounted Docker socket on any OS
# with Docker. The OS check, the Docker install and the host port check
# are skipped; the install folder must be mounted at the same path on the
# host and in the container (compose resolves it on the host). Without
# --version, a fresh install gets the image's own version
# (NITROBASE_INSTALLER_VERSION).
#
# Release channel: installing a pre-release (1.0.0-rc.1) sets
# RELEASE_CHANNEL=prerelease when .env has no channel, marked as set by
# this installer; installing a stable release later removes only a channel
# the installer set. A RELEASE_CHANNEL you set yourself is never changed.
#
# Options (all optional):
#   --version <v>       Release to install (default: latest release, or the
#                       version already installed).
#   --dir <path>        Install folder (default /opt/nitrobase).
#   --panel-bind <a>    Host address:port of the panel (default
#                       0.0.0.0:3000; 127.0.0.1:3000 with --domain).
#   --domain <host>     Panel domain: HTTPS through Traefik + Let's Encrypt,
#                       applied once you bootstrap Localhost in the panel.
#   --repo <o/n>        Repository whose releases are installed (default
#                       AydenGroup/nitrobase; env NITROBASE_REPO).
#   --image <name>      Panel image without tag (default ghcr.io/<repo>,
#                       lowercased).
#   --api-url <url>     Releases API (default https://api.github.com; Gitea or
#                       Forgejo: https://host/api/v1).
#   --raw-url <url>     Base URL of raw files at a tag (default
#                       https://raw.githubusercontent.com/<repo>).
#   --compose-url <u>   Exact URL of docker-compose.prod.yml to use.
#   --yes               Do not ask before installing Docker.
#   --skip-resource-check  Install even below the RAM and disk minimums
#                       (a small test machine; apps may not fit).
#   --uninstall         Stop and remove the containers; data and .env stay.
#   --purge             With --uninstall: also delete the data volumes and
#                       the install folder (asks you to type a confirmation).
#   --print-config      Print the resolved settings and exit (no changes).
#   -h, --help          This help.
set -Eeuo pipefail

# --- Defaults (the only place installer settings live) -------------------------
readonly PRODUCT_NAME="Nitrobase"                              # = APP_NAME (src/config/shared.ts)
readonly DEFAULT_REPO="AydenGroup/nitrobase"                   # --repo (= RELEASE_REPO_DEFAULT, src/config/shared.ts)
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
# The panel and Postgres need about 1 GB of disk; apps need the rest.
readonly MIN_DISK_MB=2000                                      # refused below
readonly RECOMMENDED_DISK_MB=5000                              # warning below
readonly HEALTH_TIMEOUT="${NITROBASE_HEALTH_TIMEOUT:-300}"     # seconds
readonly HEALTH_POLL_SECONDS=3
readonly SETUP_TOKEN_LENGTH=32                                 # hex characters
readonly RELEASES_PAGE_SIZE=10                                 # releases read when none is stable
readonly DOCKER_SOCKET="/var/run/docker.sock"                  # mounted into the installer image
readonly STABLE_IMAGE_TAG="latest"                             # moving tags of the images
readonly PRERELEASE_IMAGE_TAG="beta"                           # (release.yml)
# Set by the installer image (installer/Dockerfile): container mode, the
# image's own release (default --version of a fresh install) and its name
# (default: the panel image + -installer).
readonly CONTAINER_MODE="${NITROBASE_INSTALLER_CONTAINER:-0}"
# The image's version applies inside the image only, never on a host.
IMAGE_VERSION=""
if [ "$CONTAINER_MODE" = 1 ]; then IMAGE_VERSION="${NITROBASE_INSTALLER_VERSION:-}"; fi
readonly IMAGE_VERSION
INSTALLER_IMAGE="${NITROBASE_INSTALLER_IMAGE:-$DEFAULT_IMAGE_REGISTRY/$(printf '%s' "$DEFAULT_REPO" | tr '[:upper:]' '[:lower:]')-installer}"
readonly INSTALLER_IMAGE
# Overridable for tests only.
readonly OS_RELEASE_FILE="${NITROBASE_OS_RELEASE:-/etc/os-release}"
readonly MEMINFO_FILE="${NITROBASE_MEMINFO:-/proc/meminfo}"
readonly APT_ETC="${NITROBASE_APT_ETC:-/etc/apt}"
readonly MOUNTINFO_FILE="${NITROBASE_MOUNTINFO:-/proc/self/mountinfo}"
# -------------------------------------------------------------------------------

VERSION=""
DIR=""
PANEL_BIND=""
DOMAIN=""
# Empty: resolved from .env, else the defaults (resolve_sources).
REPO="${NITROBASE_REPO:-}"
IMAGE="${NITROBASE_IMAGE:-}"
API_URL="${NITROBASE_API_URL:-}"
RAW_URL="${NITROBASE_RAW_URL:-}"
COMPOSE_URL="${NITROBASE_COMPOSE_URL:-}"
ASSUME_YES=0
SKIP_RESOURCE_CHECK=0
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
		--skip-resource-check)
			SKIP_RESOURCE_CHECK=1
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

valid_bind() {
	[[ "$1" =~ ^([0-9]{1,3}(\.[0-9]{1,3}){3}|\[[0-9a-fA-F:]+\]):[0-9]{1,5}$ ]]
}

# Without --panel-bind, a re-run keeps the address of the install, so a
# loopback-only panel never becomes public by an upgrade. With --domain,
# a loopback address (any port) is kept, else the loopback default. A
# value in .env is the user's: it is kept even when this script would not
# accept it as --panel-bind (compose reports a broken one).
resolve_panel_bind() {
	local installed
	installed="$(env_get PANEL_BIND)"
	if [ -n "$installed" ] && ! valid_bind "$installed" && [ "$UNINSTALL" = 0 ] && [ "$PRINT_CONFIG" = 0 ]; then
		warn "PANEL_BIND=$installed in $DIR/.env is not address:port: kept as is"
	fi
	if [ -n "$DOMAIN" ]; then
		# Behind the panel domain, plain HTTP stays on the loopback only.
		case "$installed" in
		127.0.0.1:* | \[::1\]:*) PANEL_BIND="$installed" ;;
		*) PANEL_BIND="$DEFAULT_PANEL_BIND_WITH_DOMAIN" ;;
		esac
	else
		PANEL_BIND="${installed:-$DEFAULT_PANEL_BIND}"
	fi
}

validate_args() {
	DIR="${DIR:-$DEFAULT_DIR}"
	case "$DIR" in
	/*) ;;
	*) die "--dir must be an absolute path" ;;
	esac
	[ "$DIR" != "/" ] || die "--dir cannot be /"
	[[ "$DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--dir may only contain letters, digits, . _ - /"
	# One spelling per folder: compose, the mount check and the in-panel
	# updater compare it as text (/opt/x/. or /opt//x would miss the mount).
	case "$DIR/" in
	*/./* | */../* | *//*) die "--dir must not contain ., .. or empty path components (e.g. a trailing /): $DIR" ;;
	esac
	if [ -n "$VERSION" ]; then validate_version "$VERSION" "--version"; fi
	if [ -n "$DOMAIN" ]; then
		DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
		[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$ ]] || die "invalid --domain: $DOMAIN"
	fi
	if [ -n "$PANEL_BIND" ]; then
		valid_bind "$PANEL_BIND" || die "invalid --panel-bind (address:port): $PANEL_BIND"
	else
		resolve_panel_bind
	fi
	if [ "$PURGE" = 1 ] && [ "$UNINSTALL" = 0 ]; then die "--purge only goes with --uninstall"; fi
	resolve_sources
}

# Repository, image and releases API: the option (or NITROBASE_* variable),
# else what .env of an existing install holds, else the defaults. A
# --repo other than the installed one (without --image) derives the image
# from that repo.
resolve_sources() {
	local installed_repo
	# An install without RELEASE_REPO follows the official releases.
	installed_repo="$(env_get RELEASE_REPO)"
	installed_repo="${installed_repo:-$DEFAULT_REPO}"
	if [ -z "$IMAGE" ] && { [ -z "$REPO" ] || [ "$REPO" = "$installed_repo" ]; }; then
		IMAGE="$(env_get NITROBASE_IMAGE)"
	fi
	REPO="${REPO:-$installed_repo}"
	[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid --repo (owner/name): $REPO"
	if [ -z "$IMAGE" ]; then
		IMAGE="$DEFAULT_IMAGE_REGISTRY/$(printf '%s' "$REPO" | tr '[:upper:]' '[:lower:]')"
	fi
	[[ "$IMAGE" =~ ^[a-z0-9][a-z0-9._/:-]*[a-z0-9]$ ]] || die "invalid --image: $IMAGE"
	if [ -z "$API_URL" ]; then API_URL="$(env_get RELEASE_API_URL)"; fi
	API_URL="${API_URL:-$DEFAULT_API_URL}"
	API_URL="${API_URL%/}"
	if [ -z "$RAW_URL" ]; then RAW_URL="$DEFAULT_RAW_BASE/$REPO"; fi
	RAW_URL="${RAW_URL%/}"
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
	say "container=$CONTAINER_MODE"
	say "image_version=$IMAGE_VERSION"
}

in_container() {
	[ "$CONTAINER_MODE" = 1 ]
}

# --- checks -----------------------------------------------------------------

check_root() {
	if [ "$(id -u)" != "0" ]; then
		if in_container; then die "run the installer image as root (without --user)"; fi
		die "run as root (sudo bash install.sh ...)"
	fi
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
		die "only $((disk_kb / 1024)) MB free on $parent: at least $MIN_DISK_MB MB needed (--skip-resource-check to install anyway)"
	elif [ "${disk_kb:-0}" -lt $((RECOMMENDED_DISK_MB * 1024)) ]; then
		warn "only $((disk_kb / 1024)) MB free on $parent: apps want $RECOMMENDED_DISK_MB MB or more"
	fi
}

# In a container, ss would only see the container's own network: the
# containers that publish the port are listed through the socket instead
# (a host process on it makes `compose up` fail with a clear message).
port_in_use() {
	if in_container; then
		[ -n "$(docker ps --filter "publish=$1" --format '{{.Names}}' 2>/dev/null)" ]
		return
	fi
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

# --- container mode -----------------------------------------------------------

# Docker through the mounted socket (the image brings the CLI and compose).
require_docker() {
	command -v docker >/dev/null 2>&1 || die "the docker CLI is missing from this installer image"
	local server
	server="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" ||
		die "cannot reach the Docker daemon: mount its socket with -v $DOCKER_SOCKET:$DOCKER_SOCKET"
	docker compose version >/dev/null 2>&1 || die "'docker compose' (Compose v2) does not work in this installer image"
	info "Docker ${server:-?} reached through $DOCKER_SOCKET"
}

mount_hint() {
	local hint="-v $DIR:$DIR"
	if [ "$DIR" != "$DEFAULT_DIR" ]; then hint="$hint (and --dir $DIR)"; fi
	printf '%s' "$hint"
}

# Ids this container may have: the one in its own mounts (/etc/hostname,
# /etc/resolv.conf come from /var/lib/docker/containers/<id>/), then the
# hostname (the id prefix unless --hostname is set).
self_container_ids() {
	sed -n 's|.*/containers/\([0-9a-f]\{64\}\)/.*|\1|p' "$MOUNTINFO_FILE" 2>/dev/null | head -n 1 || true
	hostname 2>/dev/null || true
}

# compose resolves --project-directory (and the in-panel updater mounts it)
# on the host: $DIR must be the same folder on both sides.
check_mount() {
	local id mounts="" found=0 src dst best_src="" best_dst=""
	[ -d "$DIR" ] || die "$DIR is not mounted into the installer: add $(mount_hint) to docker run"
	if [ -r "$MOUNTINFO_FILE" ] &&
		! awk -v d="$DIR" '$5 != "/" && (d == $5 || index(d, $5 "/") == 1) { f = 1 } END { exit !f }' "$MOUNTINFO_FILE"; then
		die "$DIR is not a mount of the host: add $(mount_hint) to docker run"
	fi
	for id in $(self_container_ids); do
		if mounts="$(docker inspect --type container -f '{{range .Mounts}}{{.Source}}|{{.Destination}}{{println}}{{end}}' "$id" 2>/dev/null)"; then
			found=1
			break
		fi
	done
	# Unverified, the install could land in this container's own files.
	if [ "$found" = 0 ]; then
		die "could not find this installer container through the Docker socket to check the $DIR mount: do not pass --hostname to docker run, and mount the folder with $(mount_hint)"
	fi
	# The innermost mount holding $DIR.
	while IFS='|' read -r src dst; do
		if [ -z "$dst" ] || [ "$dst" = "/" ]; then continue; fi
		case "$DIR/" in "$dst"/*) ;; *) continue ;; esac
		if [ "${#dst}" -gt "${#best_dst}" ]; then
			best_src="$src"
			best_dst="$dst"
		fi
	done <<<"$mounts"
	[ -n "$best_dst" ] || die "$DIR is not mounted from the host: add $(mount_hint) to docker run"
	# Docker Desktop may name a shared macOS/Windows folder /host_mnt/<path>.
	if [ "$best_src" != "$best_dst" ] && [ "$best_src" != "/host_mnt$best_dst" ]; then
		die "$best_dst is mounted from $best_src on the host, but compose resolves $DIR on the host: mount the same path with $(mount_hint)"
	fi
}

# The same run again through the installer image (summary, hints), on the
# moving tag of this image's channel (--version picks the release).
rerun_command() {
	local tag="$STABLE_IMAGE_TAG" cmd
	case "$IMAGE_VERSION" in *-*) tag="$PRERELEASE_IMAGE_TAG" ;; esac
	cmd="docker run --rm -it -v $DOCKER_SOCKET:$DOCKER_SOCKET -v $DIR:$DIR $INSTALLER_IMAGE:$tag"
	if [ "$DIR" != "$DEFAULT_DIR" ]; then cmd="$cmd --dir $DIR"; fi
	printf '%s %s' "$cmd" "$*"
}

# --- release & files ----------------------------------------------------------

# First "tag_name" of a releases API answer (newest first for a list).
first_tag() {
	tr ',' '\n' | sed -n 's/^[[:space:]{[]*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# GET a releases API URL: prints the body, then the HTTP status on the last
# line (000: no answer).
api_get() {
	curl -sSL -H 'Accept: application/json' -w '\n%{http_code}' "$1" 2>/dev/null || printf '\n000'
}

latest_version() {
	local answer status tag
	answer="$(api_get "$API_URL/repos/$REPO/releases/latest")"
	status="${answer##*$'\n'}"
	case "$status" in
	200) tag="$(printf '%s' "${answer%$'\n'*}" | first_tag)" ;;
	404)
		# "latest" skips pre-releases: before the first stable release, the
		# newest pre-release is installed.
		answer="$(api_get "$API_URL/repos/$REPO/releases?per_page=$RELEASES_PAGE_SIZE")"
		status="${answer##*$'\n'}"
		[ "$status" = 200 ] || die "could not list the releases of $REPO from $API_URL (HTTP $status)"
		tag="$(printf '%s' "${answer%$'\n'*}" | first_tag)"
		[ -n "$tag" ] || die "$REPO has no release yet (or $API_URL does not know it)"
		warn "$REPO has no stable release yet: installing the pre-release $tag"
		;;
	*) die "could not read the latest release of $REPO from $API_URL (HTTP $status); pass --version to skip the lookup" ;;
	esac
	[ -n "$tag" ] || die "the latest release of $REPO has no tag"
	printf '%s' "${tag#v}"
}

env_get() {
	[ -r "$DIR/.env" ] || return 0
	sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1 | tr -d '"'
}

# Remove KEY=… lines (and, with a second argument, that exact line).
env_unset() {
	local tmp
	[ -f "$DIR/.env" ] || return 0
	tmp="$(mktemp "$DIR/.env.XXXXXX")"
	chmod 600 "$tmp"
	grep -v "^$1=" "$DIR/.env" | { if [ -n "${2:-}" ]; then grep -vxF -- "$2"; else cat; fi; } >"$tmp" || true
	mv -f "$tmp" "$DIR/.env"
}

# Marks a RELEASE_CHANNEL that this installer wrote (not the user).
readonly CHANNEL_MARKER="# RELEASE_CHANNEL set by install.sh for a pre-release"

# Pre-release installs follow the pre-release channel (see the header).
apply_channel() {
	case "$VERSION" in
	*-*)
		if [ -z "$(env_get RELEASE_CHANNEL)" ]; then
			env_set RELEASE_CHANNEL prerelease
			printf '%s\n' "$CHANNEL_MARKER" >>"$DIR/.env"
		fi
		;;
	*)
		if grep -qxF "$CHANNEL_MARKER" "$DIR/.env" 2>/dev/null; then
			env_unset RELEASE_CHANNEL "$CHANNEL_MARKER"
		fi
		;;
	esac
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
	# The panel checks the official releases (DEFAULT_REPO) by default.
	if [ "$REPO" != "$DEFAULT_REPO" ]; then env_set RELEASE_REPO "$REPO"; else env_unset RELEASE_REPO; fi
	if [ "$API_URL" != "$DEFAULT_API_URL" ]; then env_set RELEASE_API_URL "$API_URL"; else env_unset RELEASE_API_URL; fi
	apply_channel
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
		# A container only knows its own address, not the host's.
		if ! in_container; then ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
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
		if in_container; then
			say "     <server-ip> is the address of the machine running Docker; on that machine (or with"
			say "     Docker Desktop) use http://localhost:$port"
		fi
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
	if in_container; then
		say "Upgrade later from Settings → Instance, or run this image again with --version <v>:"
		say "  $(rerun_command --version '<v>')"
	else
		say "Upgrade later from Settings → Instance, or re-run this installer with --version <v>."
	fi
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
		elif in_container; then
			die "no terminal to confirm on: run docker run with -it, or pass -e NITROBASE_PURGE_CONFIRM=\"purge $DIR\""
		fi
		[ "$typed" = "purge $DIR" ] || die "not confirmed: nothing was deleted"
		docker rm -f "$UPDATER_CONTAINER" >/dev/null 2>&1 || true
		compose down --volumes --remove-orphans
		if in_container; then
			# $DIR is a mount point here: empty it; the host folder stays.
			find "$DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + ||
				die "the data volumes were removed, but some files in $DIR could not be deleted: remove the folder on the host (sudo rm -rf $DIR)"
			info "$PRODUCT_NAME and its data were removed. The empty folder $DIR stays on the host (rmdir $DIR)."
		else
			rm -rf -- "$DIR" ||
				die "the data volumes were removed, but $DIR could not be deleted: remove it yourself (sudo rm -rf $DIR)"
			info "$PRODUCT_NAME and its data were removed."
		fi
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
	if in_container; then
		require_docker
		check_mount
	fi
	if [ "$UNINSTALL" = 1 ]; then
		uninstall
		exit 0
	fi
	if ! in_container; then check_os; fi
	check_arch
	if [ "$SKIP_RESOURCE_CHECK" = 0 ]; then check_resources; fi
	if ! in_container; then install_docker; fi
	check_ports
	# --version, else the installed version (never a silent up/downgrade),
	# else the installer image's own release, else the latest release.
	if [ -z "$VERSION" ]; then
		VERSION="$(env_get NITROBASE_VERSION)"
		if [ -n "$VERSION" ]; then
			validate_version "$VERSION" "$DIR/.env"
			if [ -n "$IMAGE_VERSION" ] && [ "$IMAGE_VERSION" != "$VERSION" ]; then
				info "Keeping the installed $VERSION (this installer is $IMAGE_VERSION: pass --version $IMAGE_VERSION to switch)"
			fi
		fi
	fi
	if [ -z "$VERSION" ] && [ -n "$IMAGE_VERSION" ]; then
		VERSION="$IMAGE_VERSION"
		validate_version "$VERSION" "the installer image (NITROBASE_INSTALLER_VERSION)"
	fi
	if [ -z "$VERSION" ]; then
		VERSION="$(latest_version)"
		validate_version "$VERSION" "the latest release"
	fi
	info "Installing $PRODUCT_NAME $VERSION ($IMAGE) in $DIR"
	write_env
	download_compose
	compose config --quiet || die "docker compose rejected $DIR/docker-compose.yml"
	info "Pulling images..."
	# A locally loaded image (air-gapped install) is fine: `up` reports a
	# missing one.
	compose pull --quiet --ignore-pull-failures || true
	compose up -d --remove-orphans ||
		die "could not start $PRODUCT_NAME (is $IMAGE:$VERSION available? is port ${PANEL_BIND##*:} free? choose another with --panel-bind)"
	wait_healthy
	print_summary
}

OS_ID=""
OS_CODENAME=""
SECRETS_CREATED=0
main "$@"

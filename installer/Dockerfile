# Installer image: scripts/install.sh with the Docker CLI and Compose v2, for
# any OS with Docker (README, "Install with Docker"):
#
#   docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock \
#     -v /opt/nitrobase:/opt/nitrobase ghcr.io/aydengroup/nitrobase-installer
#
# Build from the repository root (only scripts/install.sh is sent, see
# Dockerfile.dockerignore):
#   docker build -f installer/Dockerfile --build-arg VERSION=<v> .
#
# docker:<version>-cli is Alpine with the docker CLI and its compose plugin;
# the tag and the digest are pinned. The release workflow adds the source,
# revision and license labels.
FROM docker:29.8.2-cli@sha256:35cfcf893c20f2931f4909151b5407aaaeab711277de7ce8b8f521f095d54c32

# The release this image installs by default (empty: the latest release).
ARG VERSION=""
# The image's own name, printed in the upgrade hint (empty: install.sh
# derives it from its default repository).
ARG INSTALLER_IMAGE=""

LABEL org.opencontainers.image.title="Nitrobase installer" \
      org.opencontainers.image.description="Installs, upgrades and uninstalls Nitrobase through the Docker socket" \
      org.opencontainers.image.version="${VERSION}"

# What install.sh calls beyond docker: bash, curl and GNU coreutils (od,
# df, mktemp…); grep, sed, awk, find come from Alpine.
RUN apk add --no-cache bash curl coreutils

COPY scripts/install.sh /usr/local/bin/nitrobase-install

ENV NITROBASE_INSTALLER_CONTAINER=1 \
    NITROBASE_INSTALLER_VERSION="${VERSION}" \
    NITROBASE_INSTALLER_IMAGE="${INSTALLER_IMAGE}"

ENTRYPOINT ["bash", "/usr/local/bin/nitrobase-install"]

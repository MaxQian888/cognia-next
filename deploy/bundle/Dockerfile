# syntax=docker/dockerfile:1.7
#
# cognia-agent-bundle (ADR-0183): the agent CLIs, brought to whatever image a
# project runs in. Never run as a sandbox itself — a driver copies its tree
# into the sandbox with `cognia-sandboxd install`, which is also its
# entrypoint.
#
#   /opt/cognia/bundle-manifest.json   release tag, runtimes, libc per runtime
#   /opt/cognia/bin/cognia-sandboxd    static (musl)
#   /opt/cognia/common/{git,bin}       static git + rg, either libc
#   /opt/cognia/certs/ca-bundle.pem    for images without a CA store
#   /opt/cognia/glibc/                 node, npm CLIs, glibc vendor binaries
#   /opt/cognia/musl/                  node on its own loader, musl builds
#
# Build context: the repository root (cognia-sandboxd builds in the Cargo
# workspace). Every version comes from deploy/bundle/agent-versions.json;
# `node scripts/build/bundle-agent-versions.mjs check` fails when the two ARGs
# below drift from it. Every download is verified (sha256, or curl's PGP
# signature) before use, and every command is run once before it ships.

ARG NODE_VERSION=26.8.2
ARG ALPINE_VERSION=3.24

# ── cognia-sandboxd, static musl ─────────────────────────────────────────────
FROM rust:1.95-alpine AS sandboxd
RUN apk add --no-cache musl-dev binutils
WORKDIR /work
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY .cargo ./.cargo
COPY src-tauri ./src-tauri
COPY crates ./crates
# Out-of-workspace path dependency of src-tauri; cargo reads every member's
# manifest even when building one package.
COPY services/signaling-server/core ./services/signaling-server/core
RUN cargo build --release --locked -p cognia-sandboxd --bin cognia-sandboxd \
    && install -D -m 0755 target/release/cognia-sandboxd /out/bin/cognia-sandboxd \
    && if readelf -l /out/bin/cognia-sandboxd | grep -q INTERP; then \
         echo "cognia-sandboxd must be statically linked" >&2; exit 1; \
       fi

# ── pin tooling ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS pins
WORKDIR /build
COPY deploy/bundle/agent-versions.json scripts/build/bundle-agent-versions.mjs ./

# ── static git (with a minimal static libcurl) ───────────────────────────────
FROM pins AS git
RUN apk add --no-cache build-base binutils gnupg linux-headers openssl-dev \
      openssl-libs-static perl pkgconf tar xz zlib-dev zlib-static
COPY deploy/bundle/build-static-git.sh /build/
RUN node bundle-agent-versions.mjs fetch-tool --pins agent-versions.json --tool curl --out /tmp/curl.tar.xz \
    && node bundle-agent-versions.mjs fetch-tool --pins agent-versions.json --tool git --out /tmp/git.tar.xz \
    && sh /build/build-static-git.sh /tmp/curl.tar.xz /tmp/git.tar.xz /out

# ── ripgrep and the CA bundle ────────────────────────────────────────────────
FROM pins AS tools
ARG TARGETARCH
RUN apk add --no-cache ca-certificates tar
RUN node bundle-agent-versions.mjs fetch-tool --pins agent-versions.json --tool ripgrep --arch "$TARGETARCH" --out /tmp/rg.tar.gz \
    && mkdir -p /tmp/rg /out/common/bin /out/certs \
    && tar -xzf /tmp/rg.tar.gz -C /tmp/rg --strip-components=1 \
    && install -m 0755 /tmp/rg/rg /out/common/bin/rg \
    && cp /etc/ssl/certs/ca-certificates.crt /out/certs/ca-bundle.pem

# ── glibc tree ───────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS glibc
ARG TARGETARCH
COPY --from=pins /build /build
COPY deploy/bundle/npm/package.json deploy/bundle/npm/package-lock.json /opt/cognia/glibc/lib/agents/
RUN cd /opt/cognia/glibc/lib/agents \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# The shims name /cognia, where a sandbox mounts the tree; the smoke runs
# see it there too.
RUN ln -s /opt/cognia /cognia \
    && node /build/bundle-agent-versions.mjs stage --pins /build/agent-versions.json \
         --libc glibc --arch "$TARGETARCH" --tree /opt/cognia/glibc

# ── musl tree ────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS musl
ARG TARGETARCH
RUN apk add --no-cache patchelf tar
COPY --from=pins /build /build
COPY deploy/bundle/npm/package.json deploy/bundle/npm/package-lock.json /opt/cognia/musl/lib/agents/
RUN cd /opt/cognia/musl/lib/agents \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
RUN ln -s /opt/cognia /cognia \
    && node /build/bundle-agent-versions.mjs stage --pins /build/agent-versions.json \
         --libc musl --arch "$TARGETARCH" --tree /opt/cognia/musl

# ── manifest ─────────────────────────────────────────────────────────────────
FROM pins AS manifest
ARG TARGETARCH
ARG BUNDLE_RELEASE_TAG=dev
RUN mkdir -p /out \
    && node bundle-agent-versions.mjs manifest --pins agent-versions.json \
         --arch "$TARGETARCH" --release-tag "$BUNDLE_RELEASE_TAG" --out /out/bundle-manifest.json

# ── assemble, and install it the way a driver will ───────────────────────────
FROM alpine:${ALPINE_VERSION} AS assemble
COPY --from=sandboxd /out/ /opt/cognia/
COPY --from=git /out/ /opt/cognia/
COPY --from=tools /out/ /opt/cognia/
COPY --from=glibc /opt/cognia/glibc /opt/cognia/glibc
COPY --from=musl /opt/cognia/musl /opt/cognia/musl
COPY --from=manifest /out/bundle-manifest.json /opt/cognia/bundle-manifest.json
# The installer refuses absolute or escaping symlinks and special files; run
# every stage once so a bad tree fails here, not in someone's sandbox.
RUN /opt/cognia/bin/cognia-sandboxd install --stage core --from /opt/cognia --to /tmp/check \
    && /opt/cognia/bin/cognia-sandboxd install --stage libc --libc glibc --from /opt/cognia --to /tmp/check \
    && /opt/cognia/bin/cognia-sandboxd install --stage libc --libc musl --from /opt/cognia --to /tmp/check \
    && rm -rf /tmp/check

FROM scratch
COPY --from=assemble /opt/cognia /opt/cognia
LABEL org.opencontainers.image.title="cognia-agent-bundle" \
      org.opencontainers.image.description="Agent CLIs and cognia-sandboxd, injected into sandbox images (ADR-0183)"
ENTRYPOINT ["/opt/cognia/bin/cognia-sandboxd"]
CMD ["install", "--stage", "core"]

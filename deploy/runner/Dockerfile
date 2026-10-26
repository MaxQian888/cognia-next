# syntax=docker/dockerfile:1.7
# cognia-runner — one external Agent per container (ADR-0059 T2 / D9).
#
# Build from the REPOSITORY ROOT:
#   docker build -f deploy/runner/Dockerfile --target selected \
#     --build-arg AGENT_RUNTIMES=codex-app-server -t cognia-runner:codex .
#   docker build -f deploy/runner/Dockerfile --target full -t cognia-runner:full .
# The default final target remains Full for existing callers. New deployments
# can choose selected; all/full includes every verified distributable runtime,
# none includes only the execution base. Full additionally retains Cline and
# the optional unverified Cursor installer for legacy compatibility.
#
# RUNTIME_IMAGE customizes the project/toolchain base. Supported custom bases
# are Debian-derived glibc images with apt-get; selected brings pinned Node.
ARG NODE_VERSION=26.12.1
ARG RUNTIME_IMAGE=node:26.12.1-bookworm-slim

FROM node:${NODE_VERSION}-bookworm-slim AS selected-build
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates patchelf libatomic1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY deploy/bundle/agent-versions.json deploy/bundle/Dockerfile ./deploy/bundle/
COPY deploy/bundle/npm/package.json deploy/bundle/npm/package-lock.json ./deploy/bundle/npm/
COPY scripts/build/bundle-agent-versions.mjs ./scripts/build/bundle-agent-versions.mjs
COPY protocol/external-agent-runtimes.json ./protocol/external-agent-runtimes.json
COPY crates/cognia-sandboxd/src/layout.rs ./crates/cognia-sandboxd/src/layout.rs
ARG AGENT_RUNTIMES=codex-app-server
RUN node scripts/build/bundle-agent-versions.mjs prepare --root /build \
      --runtimes "$AGENT_RUNTIMES" --out /selection
RUN mkdir -p /cognia/glibc/lib/agents \
    && cp /selection/npm/package*.json /cognia/glibc/lib/agents/ \
    && cd /cognia/glibc/lib/agents \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# Dispatcher-only changes should reuse the selected dependency installation.
COPY deploy/runner/install-selected.mjs ./deploy/runner/install-selected.mjs
RUN node scripts/build/bundle-agent-versions.mjs stage --pins /selection/agent-versions.json \
      --libc glibc --arch "$TARGETARCH" --tree /cognia/glibc \
    && node deploy/runner/install-selected.mjs install \
      /selection/agent-versions.json /selection/npm/package.json \
      /build/deploy/bundle/npm/package.json /build/deploy/bundle/agent-versions.json

FROM ${RUNTIME_IMAGE} AS base
USER root
RUN test -f /etc/debian_version \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
# Root is deliberate: the server owns the mounted workspace trees as root.
# The container's locked-down HostConfig is the T2 isolation boundary.
WORKDIR /workspace
ENTRYPOINT []
CMD ["bash"]

FROM base AS selected
COPY --from=selected-build /cognia /cognia
# Resolve project npm from the actual custom base before adding our wrapper
# to PATH; Debian npm and custom toolchains need not use /usr/local/bin.
RUN COGNIA_NATIVE_NPX="$(command -v npx || true)" \
      /cognia/glibc/node/bin/node /cognia/runner/install-selected.mjs configure-base \
      /cognia/runner/agent-selection.json
ENV PATH="/cognia/runner/bin:/cognia/glibc/bin:/cognia/glibc/node/bin:${PATH}"
LABEL org.opencontainers.image.title="cognia-runner-selected" \
      org.opencontainers.image.description="Selected exact-version Agent runtimes; no npx download fallback"

FROM base AS full
# Empty overrides use the master bundle pins. Explicit overrides must be exact.
# Full is compatibility-only; selected installs the integrity-locked subset.
ARG CLAUDE_CODE_VERSION=""
ARG CLAUDE_CODE_ACP_VERSION=""
ARG CODEX_VERSION=""
ARG CODEX_ACP_VERSION=""
ARG GEMINI_CLI_VERSION=""
ARG COPILOT_CLI_VERSION=""
ARG QWEN_CODE_VERSION=""
ARG PI_ACP_VERSION=""
ARG PI_CODING_AGENT_VERSION=""
ARG OPENCODE_VERSION=""
ARG CLINE_VERSION=3.0.73
ARG INSTALL_CURSOR_AGENT=1
ARG INSTALL_KIRO_CLI=1
ARG INSTALL_DROID_CLI=1
COPY deploy/runner/install-agents.sh deploy/runner/install-selected.mjs /tmp/
COPY deploy/bundle/agent-versions.json /tmp/agent-versions.json
COPY deploy/bundle/npm/package.json /tmp/agent-packages.json
RUN COGNIA_AGENT_PACKAGE_JSON=/tmp/agent-packages.json \
    COGNIA_AGENT_PINS_JSON=/tmp/agent-versions.json \
    CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION \
    CLAUDE_CODE_ACP_VERSION=$CLAUDE_CODE_ACP_VERSION \
    CODEX_VERSION=$CODEX_VERSION CODEX_ACP_VERSION=$CODEX_ACP_VERSION \
    GEMINI_CLI_VERSION=$GEMINI_CLI_VERSION COPILOT_CLI_VERSION=$COPILOT_CLI_VERSION \
    QWEN_CODE_VERSION=$QWEN_CODE_VERSION PI_ACP_VERSION=$PI_ACP_VERSION \
    PI_CODING_AGENT_VERSION=$PI_CODING_AGENT_VERSION OPENCODE_VERSION=$OPENCODE_VERSION \
    CLINE_VERSION=$CLINE_VERSION INSTALL_CURSOR_AGENT=$INSTALL_CURSOR_AGENT \
    INSTALL_KIRO_CLI=$INSTALL_KIRO_CLI INSTALL_DROID_CLI=$INSTALL_DROID_CLI \
    bash /tmp/install-agents.sh \
    && rm -f /tmp/install-agents.sh /tmp/install-selected.mjs /tmp/agent-versions.json /tmp/agent-packages.json
ENV PATH="/cognia/runner/bin:${PATH}"
LABEL org.opencontainers.image.title="cognia-runner-full" \
      org.opencontainers.image.description="Legacy compatibility Agent set; optional unverified Cursor installer"

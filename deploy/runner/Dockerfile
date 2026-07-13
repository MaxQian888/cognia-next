# cognia-runner — per-agent external-agent runner (ADR-0059 T2 / D9).
#
# At the T2 topology rung, `ExecBackend::Container` (R13) creates ONE of
# these per spawned agent: the agent binary is the container's PID 1 with
# stdio attached (no warm pool, no `docker exec`), and the only mount is the
# agent's own workspace — a subpath of the shared `cognia_workspaces` volume.
# If the image is absent on the daemon, the backend pulls it on first spawn.
#
# Agent CLI versions come from deploy/runner/install-agents.sh — the SAME
# script the cognia-server runtime-full stage runs, so the two images can't
# drift. Pin via the ARGs below (they map onto the script's env knobs).
#
# Build:  docker build -t cognia-runner deploy/runner
# CI:     built/published by the `cognia-runner` matrix entry in images.yml.

FROM node:22-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CLAUDE_CODE_ACP_VERSION=latest
ARG CODEX_VERSION=latest
ARG CODEX_ACP_VERSION=latest
ARG GEMINI_CLI_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG CLINE_VERSION=latest
ARG INSTALL_CURSOR_AGENT=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

COPY install-agents.sh /tmp/install-agents.sh
RUN CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION \
    CLAUDE_CODE_ACP_VERSION=$CLAUDE_CODE_ACP_VERSION \
    CODEX_VERSION=$CODEX_VERSION \
    CODEX_ACP_VERSION=$CODEX_ACP_VERSION \
    GEMINI_CLI_VERSION=$GEMINI_CLI_VERSION \
    OPENCODE_VERSION=$OPENCODE_VERSION \
    CLINE_VERSION=$CLINE_VERSION \
    INSTALL_CURSOR_AGENT=$INSTALL_CURSOR_AGENT \
    bash /tmp/install-agents.sh \
    && rm -f /tmp/install-agents.sh

# Root inside the runner is deliberate: the container itself is the L2
# isolation boundary (locked-down HostConfig, no-new-privileges, resource
# ceilings — see container_backend.rs), and the workspace subpath on the
# shared volume is created by cognia-server (root). A non-root user here
# cannot write those root-owned workspace trees, which silently breaks
# every agent's first file edit.
WORKDIR /workspace

# PID 1 is the agent binary (cmd comes from RunnerSpec); this CMD only
# matters when the image is run by hand.
CMD ["bash"]

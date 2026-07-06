# cognia-runner — per-workspace external-agent runner (ADR-0059 T2 / D9).
#
# At the T2 topology rung, `ExecBackend::Container` (R13) spawns one of these
# per workspace instead of local processes: image = the external agent CLIs +
# git + a mounted workspace volume. The container idles (`sleep infinity`);
# the backend execs agent processes into it per session, so one warm runner
# serves many spawns without container-start latency.
#
# Agent CLI versions come from deploy/runner/install-agents.sh — the SAME
# script the cognia-server runtime-full stage runs, so the two images can't
# drift. Pin via the ARGs below (they map onto the script's env knobs).
#
# Build:  docker build -t cognia-runner deploy/runner
# CI:     the dormant `cognia-runner` matrix entry in images.yml activates
#         automatically now that this file exists.

FROM node:22-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CLAUDE_CODE_ACP_VERSION=latest
ARG CODEX_VERSION=latest
ARG CODEX_ACP_VERSION=latest
ARG GEMINI_CLI_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG INSTALL_CURSOR_AGENT=0

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
    INSTALL_CURSOR_AGENT=$INSTALL_CURSOR_AGENT \
    bash /tmp/install-agents.sh \
    && rm -f /tmp/install-agents.sh

# Non-root: the workspace volume is the only writable surface an agent needs.
RUN useradd --create-home --shell /bin/bash agent
USER agent
WORKDIR /workspace

# Idle until ExecBackend::Container execs an agent process in.
CMD ["sleep", "infinity"]

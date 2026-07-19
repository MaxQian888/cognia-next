# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    COGNIA_WORKSPACE_ROOT=/workspace \
    COGNIA_BROWSER_PROFILES_ROOT=/profiles \
    COGNIA_BROWSER_OVERLAY_PATH=/opt/cognia-runtime/src/overlay.injected.js \
    COGNIA_WORKSPACE_RUNTIME_PORT=27910

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /opt/cognia-runtime
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json /opt/cognia-runtime-root/
COPY services/workspace-runtime/package.json /opt/cognia-runtime-root/services/workspace-runtime/package.json
RUN cd /opt/cognia-runtime-root \
    && pnpm install --filter @cognia/workspace-runtime --prod --frozen-lockfile \
    && cp -a services/workspace-runtime/node_modules /opt/cognia-runtime/node_modules

COPY services/workspace-runtime/src ./src
COPY lib/browser/overlay.injected.js ./src/overlay.injected.js
COPY services/workspace-runtime/entrypoint.sh /usr/local/bin/cognia-workspace-runtime
RUN chmod 0755 /usr/local/bin/cognia-workspace-runtime \
    && install -d -o pwuser -g pwuser /workspace /profiles

EXPOSE 27910
ENTRYPOINT ["/usr/local/bin/cognia-workspace-runtime"]

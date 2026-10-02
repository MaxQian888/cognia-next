# Container image for the external probe / mirror. Build from
# services/status-server/probe after `pnpm build`:
#   docker build -f deploy/Dockerfile -t cognia-status-probe:<version> .
# The bundle has no npm dependencies at runtime; only Node is needed.

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app
COPY --chown=root:root --chmod=0444 dist/cognia-status-probe.mjs /app/cognia-status-probe.mjs

# Spool / mirror data; mount a volume here so batches survive restarts.
RUN mkdir -p /var/lib/cognia-status-probe /var/lib/cognia-status-mirror \
 && chown node:node /var/lib/cognia-status-probe /var/lib/cognia-status-mirror \
 && chmod 0700 /var/lib/cognia-status-probe
VOLUME ["/var/lib/cognia-status-probe", "/var/lib/cognia-status-mirror"]

USER node
# Mirror listener when `mirror` (or run with mirror.enabled) is used; bind
# host 0.0.0.0 in the config inside a container.
EXPOSE 8080

# SIGTERM aborts in-flight runs and keeps pending batches in the spool.
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/cognia-status-probe.mjs"]
CMD ["run", "--config", "/config/config.json"]

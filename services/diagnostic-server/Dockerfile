FROM rust:1.95-bookworm AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
COPY openapi.yaml ./openapi.yaml
RUN cargo build --release --locked
RUN cargo install minidump-stackwalk --version 0.26.1 --locked --root /opt/minidump-stackwalk

FROM debian:bookworm-slim AS runtime

ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="Cognia Diagnostic Service" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$BUILD_DATE" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cognia \
    && useradd --uid 10001 --gid cognia --no-create-home --shell /usr/sbin/nologin cognia \
    && install -d -o cognia -g cognia /var/lib/cognia/diagnostics/tmp

COPY --from=builder /build/target/release/cognia-diagnostic-server /usr/local/bin/cognia-diagnostic-server
COPY --from=builder /opt/minidump-stackwalk/bin/minidump-stackwalk /usr/local/bin/minidump-stackwalk

USER 10001:10001
EXPOSE 8080
ENV DIAGNOSTIC_BIND=0.0.0.0:8080 \
    MINIDUMP_STACKWALK_PATH=/usr/local/bin/minidump-stackwalk \
    PROCESSING_TEMP_DIR=/var/lib/cognia/diagnostics/tmp \
    RUST_LOG=cognia_diagnostic_server=info,tower_http=info

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/health/live || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/cognia-diagnostic-server"]

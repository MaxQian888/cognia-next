FROM rust:1.93-bookworm AS builder
WORKDIR /build
# Copy the workspace manifests + sources. `core/` is a workspace member and the
# binary depends on it via `path = "core"`; Cargo.lock is required by `--locked`.
COPY Cargo.toml Cargo.lock ./
COPY core ./core
COPY src ./src
COPY tests ./tests
RUN cargo build --release --locked

FROM debian:bookworm-slim
# curl is used by the compose healthcheck (the base image ships neither curl
# nor wget, so an exec-form HTTP healthcheck is otherwise impossible).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 cognia \
 && useradd --system --uid 10001 --gid cognia --home-dir /nonexistent --shell /usr/sbin/nologin cognia
COPY --from=builder /build/target/release/cognia-signaling-server /usr/local/bin/cognia-signaling-server
ENV PORT=7892
EXPOSE 7892
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/cognia-signaling-server"]

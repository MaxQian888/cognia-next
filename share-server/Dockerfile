FROM rust:1.82-bookworm AS builder
WORKDIR /build
# Copy the workspace manifests + sources. `core/` is a workspace member; the
# TypeScript `worker/` and `pages/` dirs are not Rust crates and are not copied.
COPY Cargo.toml Cargo.lock ./
COPY core ./core
COPY src ./src
COPY tests ./tests
# rusqlite is built with the `bundled` feature, so SQLite compiles statically
# into the binary — no system libsqlite3 needed at runtime.
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/cognia-share-server /usr/local/bin/cognia-share-server
# Persist the SQLite database on a mounted volume; restarts must not lose shares.
ENV PORT=8787 \
    SHARE_DB_PATH=/data/shares.sqlite
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/cognia-share-server"]

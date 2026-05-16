FROM rust:1.82-bookworm AS builder
WORKDIR /build
COPY Cargo.toml ./
COPY src ./src
COPY tests ./tests
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/cognia-signaling-server /usr/local/bin/cognia-signaling-server
ENV PORT=7892
EXPOSE 7892
ENTRYPOINT ["/usr/local/bin/cognia-signaling-server"]

# syntax=docker/dockerfile:1.7-labs
ARG BASE_RUST=docker.io/library/rust:1.80-slim
ARG BASE_RUNTIME=docker.io/library/debian:bookworm-slim

FROM --platform=$BUILDPLATFORM ${BASE_RUST} AS builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config clang lld libssl-dev ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY . .
# Build mit Cache-Mounts wie gewohnt
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo build --release \
      --manifest-path services/sharepoint-ingest/Cargo.toml --locked

FROM ${BASE_RUNTIME}
# Für rustls reicht i.d.R. ca-certificates; libssl3 kannst du drinlassen für Konsistenz
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /usr/local/bin
COPY --from=builder /src/target/release/sharepoint-ingest .
ENV RUST_LOG=info
EXPOSE 8080
CMD ["./sharepoint-ingest"]

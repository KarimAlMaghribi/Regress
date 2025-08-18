# syntax=docker/dockerfile:1.7-labs
FROM --platform=$BUILDPLATFORM rust:1.80-slim as builder
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config clang lld libssl-dev ca-certificates sccache \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_TOOLCHAIN=stable \
    RUSTC_WRAPPER=sccache \
    CC=clang \
    CXX=clang++ \
    MALLOC_ARENA_MAX=2

COPY Cargo.toml Cargo.lock ./
COPY shared/Cargo.toml shared/Cargo.toml
COPY services/history-service/Cargo.toml services/history-service/Cargo.toml
COPY shared ./shared
COPY services/history-service ./services/history-service

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/sccache \
    cargo build --release --package history-service --manifest-path services/history-service/Cargo.toml --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/history-service /usr/local/bin/history-service
CMD ["history-service"]

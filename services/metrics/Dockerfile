# syntax=docker/dockerfile:1.7-labs
FROM --platform=$BUILDPLATFORM rust:1.80-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential pkg-config clang lld libssl-dev ca-certificates tesseract-ocr sccache \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV RUSTUP_TOOLCHAIN=stable \
    RUSTC_WRAPPER=sccache \
    CC=clang \
    CXX=clang++ \
    MALLOC_ARENA_MAX=2

COPY Cargo.toml Cargo.lock ./
COPY shared/Cargo.toml shared/Cargo.toml
COPY services/metrics/Cargo.toml services/metrics/Cargo.toml
COPY shared ./shared
COPY services/metrics ./services/metrics

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/sccache \
    cargo build --release --package metrics-service --manifest-path services/metrics/Cargo.toml --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/metrics-service /usr/local/bin/metrics-service
CMD ["metrics-service"]

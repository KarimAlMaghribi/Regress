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
COPY services/api-gateway/Cargo.toml services/api-gateway/Cargo.toml
COPY shared/Cargo.toml shared/Cargo.toml

COPY shared ./shared
COPY services/api-gateway ./services/api-gateway

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/sccache \
    cargo build --release --package api-gateway --manifest-path services/api-gateway/Cargo.toml --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates tesseract-ocr libssl3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin
COPY --from=builder /usr/src/app/target/release/api-gateway .
EXPOSE 8080
CMD ["./api-gateway"]

# syntax=docker/dockerfile:1.7-labs
FROM --platform=$BUILDPLATFORM rust:1.80-slim as builder
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config clang lld libtesseract-dev libleptonica-dev tesseract-ocr ca-certificates libssl-dev sccache \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_TOOLCHAIN=stable \
    RUSTC_WRAPPER=sccache \
    CC=clang \
    CXX=clang++ \
    MALLOC_ARENA_MAX=2

COPY Cargo.toml Cargo.lock ./
COPY shared/Cargo.toml shared/Cargo.toml
COPY services/text-extraction/Cargo.toml services/text-extraction/Cargo.toml
COPY shared ./shared
COPY services/text-extraction ./services/text-extraction

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/sccache \
    cargo build --release --package text-extraction --manifest-path services/text-extraction/Cargo.toml --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        libssl3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/text-extraction /usr/local/bin/text-extraction
CMD ["text-extraction"]

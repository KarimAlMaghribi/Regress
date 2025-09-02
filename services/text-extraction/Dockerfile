# syntax=docker/dockerfile:1.7-labs
FROM --platform=$BUILDPLATFORM rust:1.80-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config clang lld libtesseract-dev libleptonica-dev libssl-dev ca-certificates sccache \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV RUSTUP_TOOLCHAIN=stable RUSTC_WRAPPER=sccache CC=clang CXX=clang++ MALLOC_ARENA_MAX=2

COPY . .

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/sccache \
    cargo build --release --package text-extraction \
      --manifest-path services/text-extraction/Cargo.toml --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu \
      poppler-utils libssl3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
WORKDIR /usr/local/bin
COPY --from=builder /app/target/release/text-extraction .
CMD ["./text-extraction"]


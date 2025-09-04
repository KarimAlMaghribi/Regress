# syntax=docker/dockerfile:1.7
FROM --platform=$BUILDPLATFORM rust:1.80-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config clang lld libssl-dev ca-certificates sccache \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV RUSTUP_TOOLCHAIN=stable \
    RUSTC_WRAPPER=sccache \
    CC=clang \
    CXX=clang++ \
    MALLOC_ARENA_MAX=2

COPY . .

RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/sccache,sharing=locked \
    cargo build --release --package pdf-ingest \
      --manifest-path services/pdf-ingest/Cargo.toml --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libssl3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin
COPY --from=builder /app/target/release/pdf-ingest .

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/pdf-ingest"]

# syntax=docker/dockerfile:1.7-labs
ARG BASE_RUST=docker.io/library/rust:1.80-slim
ARG BASE_RUNTIME=docker.io/library/debian:bookworm-slim

########################
# Build stage
########################
FROM --platform=$BUILDPLATFORM ${BASE_RUST} AS builder
WORKDIR /src

# Tooling fürs Build (OpenSSL, Clang/LLD helfen rdkafka/openssl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config clang lld libssl-dev ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# ----- 1) Manifeste & Lock zuerst (besserer Cache-Hit) -----
# Workspace-Root-Manifeste
COPY Cargo.toml Cargo.lock ./
# Member-Manifeste (so many as you have; Beispiele:)
COPY services/pipeline-api/Cargo.toml services/pipeline-api/Cargo.toml
COPY shared/Cargo.toml shared/Cargo.toml

# Optional: Dependencies vorab ziehen (nutzt --locked + Cache)
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo fetch --manifest-path services/pipeline-api/Cargo.toml --locked

# ----- 2) Quellen erst danach (inkl. consolidation.rs) -----
COPY services/pipeline-api/src services/pipeline-api/src
COPY shared ./shared
# (ggf. weitere Workspace-Mitglieder hier kopieren)

# Sanity-Check: Stelle sicher, dass consolidation.rs wirklich da ist
RUN test -f services/pipeline-api/src/consolidation.rs

# ----- 3) Build -----
# Zusätzliches Build-Cache für target/
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release \
      --manifest-path services/pipeline-api/Cargo.toml --locked

########################
# Runtime stage
########################
FROM --platform=$TARGETPLATFORM ${BASE_RUNTIME}
# rdkafka braucht in vielen Setups die Runtime-Lib; libssl für TLS
RUN apt-get update && apt-get install -y --no-install-recommends \
      libssl3 ca-certificates librdkafka1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin
COPY --from=builder /src/target/release/pipeline-api .

ENV RUST_LOG=info
# Optional härter: non-root
# RUN useradd -r -u 10001 app && chown app:app /usr/local/bin/pipeline-api
# USER app

CMD ["./pipeline-api"]

ARG REGISTRY_MIRROR=docker.adesso.claims/library

FROM ${REGISTRY_MIRROR}/rust:1.80-slim AS builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config clang lld libssl-dev ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY shared ./shared
COPY services/pipeline-runner/Cargo.toml ./services/pipeline-runner/Cargo.toml
COPY services/pipeline-runner/src ./services/pipeline-runner/src

RUN cargo build --release --package pipeline-runner \
    --manifest-path services/pipeline-runner/Cargo.toml --locked

FROM ${REGISTRY_MIRROR}/debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /usr/local/bin
COPY --from=builder /src/target/release/pipeline-runner .
ENV RUST_LOG=info
CMD ["./pipeline-runner"]

ARG REGISTRY_MIRROR=docker.adesso.claims/library

FROM ${REGISTRY_MIRROR}/rust:1.80-slim AS builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config clang lld libssl-dev ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

# nur notwendige Dateien kopieren
COPY Cargo.toml Cargo.lock ./
COPY shared ./shared
COPY services/api-gateway/Cargo.toml ./services/api-gateway/Cargo.toml
COPY services/api-gateway/src ./services/api-gateway/src

RUN cargo build --release --package api-gateway \
    --manifest-path services/api-gateway/Cargo.toml --locked

FROM ${REGISTRY_MIRROR}/debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /usr/local/bin
COPY --from=builder /src/target/release/api-gateway .
ENV RUST_LOG=info
CMD ["./api-gateway"]

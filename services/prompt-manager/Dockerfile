ARG REGISTRY_MIRROR=docker.adesso.claims/library

FROM ${REGISTRY_MIRROR}/rust:1.80-slim AS builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config clang lld libssl-dev ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY shared ./shared
COPY services/text-extraction/Cargo.toml ./services/text-extraction/Cargo.toml
COPY services/text-extraction/src ./services/text-extraction/src

RUN cargo build --release --package text-extraction \
    --manifest-path services/text-extraction/Cargo.toml --locked

FROM ${REGISTRY_MIRROR}/debian:bookworm-slim
# pdftotext aus poppler-utils + Runtime-SSL
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils libssl3 ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /usr/local/bin
COPY --from=builder /src/target/release/text-extraction .
ENV RUST_LOG=info
CMD ["./text-extraction"]

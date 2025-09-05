ARG BASE_RUST=rust:1.80-slim
ARG BASE_DEBIAN=debian:bookworm-slim

FROM ${BASE_RUST} AS builder
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config clang lld libssl-dev ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY shared ./shared
COPY services/pdf-ingest/Cargo.toml ./services/pdf-ingest/Cargo.toml
COPY services/pdf-ingest/src ./services/pdf-ingest/src

RUN cargo build --release --package pdf-ingest \
    --manifest-path services/pdf-ingest/Cargo.toml --locked

FROM ${BASE_DEBIAN}
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3 ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /usr/local/bin
COPY --from=builder /src/target/release/pdf-ingest .
ENV RUST_LOG=info
CMD ["./pdf-ingest"]

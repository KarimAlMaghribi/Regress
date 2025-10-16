# syntax=docker/dockerfile:1

FROM rust:1.75 as builder
WORKDIR /app

ENV RUSTFLAGS="-C target-cpu=native"

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY shared ./shared
COPY services ./services

RUN cargo build --release -p sharepoint-ingest

FROM gcr.io/distroless/cc-debian12
WORKDIR /app
COPY --from=builder /app/target/release/sharepoint-ingest /usr/local/bin/sharepoint-ingest

ENV RUST_LOG=info
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/sharepoint-ingest"]

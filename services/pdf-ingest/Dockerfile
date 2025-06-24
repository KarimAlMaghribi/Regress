FROM rust:1.72 as builder
WORKDIR /app
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
COPY services/pdf-ingest ./services/pdf-ingest
RUN cargo build --release --package pdf-ingest --manifest-path services/pdf-ingest/Cargo.toml

FROM debian:buster-slim
COPY --from=builder /app/target/release/pdf-ingest /usr/local/bin/pdf-ingest
CMD ["pdf-ingest"]

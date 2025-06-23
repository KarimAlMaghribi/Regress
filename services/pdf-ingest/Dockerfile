FROM rust:1.72 as builder
WORKDIR /app
COPY ../../Cargo.toml ../../shared/Cargo.toml ./
COPY ../../shared ./shared
COPY . .
RUN cargo build --release

FROM debian:buster-slim
COPY --from=builder /app/target/release/pdf-ingest /usr/local/bin/pdf-ingest
CMD ["pdf-ingest"]

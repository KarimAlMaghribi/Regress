FROM rust:1.70-slim AS builder
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config clang libssl-dev ca-certificates tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
COPY services ./services
RUN cargo build --release --package metrics-service --manifest-path services/metrics/Cargo.toml

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/metrics-service /usr/local/bin/metrics-service
CMD ["metrics-service"]

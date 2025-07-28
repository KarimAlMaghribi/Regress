FROM rustlang/rust:nightly-slim as builder
WORKDIR /app
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
COPY services ./services
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config clang libssl-dev ca-certificates tesseract-ocr \
    && rm -rf /var/lib/apt/lists/* \
    && cargo build --release --package pipeline-api --manifest-path services/pipeline-api/Cargo.toml

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        libssl3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/pipeline-api /usr/local/bin/pipeline-api
CMD ["pipeline-api"]

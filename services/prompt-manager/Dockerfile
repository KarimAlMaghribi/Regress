FROM rustlang/rust:nightly-slim as builder
WORKDIR /app
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
# Copy all service crates so the workspace is complete
COPY services ./services
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config clang libssl-dev ca-certificates tesseract-ocr \
    && rm -rf /var/lib/apt/lists/* \
    && cargo build --release --package prompt-manager --manifest-path services/prompt-manager/Cargo.toml

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        libssl3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/prompt-manager /usr/local/bin/prompt-manager
CMD ["prompt-manager"]

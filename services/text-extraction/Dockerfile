FROM rustlang/rust:nightly-slim as builder
WORKDIR /app
# Install system packages required to compile the text-extraction crate
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config clang libtesseract-dev libleptonica-dev tesseract-ocr ca-certificates libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
# Copy all service crates so the workspace is complete
COPY services ./services
RUN cargo build --release --package text-extraction --manifest-path services/text-extraction/Cargo.toml

FROM debian:bookworm-slim
# Runtime dependencies for the built binary
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        libssl3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/text-extraction /usr/local/bin/text-extraction
CMD ["text-extraction"]

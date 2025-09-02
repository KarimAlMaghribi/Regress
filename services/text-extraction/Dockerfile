# syntax=docker/dockerfile:1.7-labs

############################
# Build-Stage
############################
FROM --platform=$BUILDPLATFORM rust:1.80-slim AS builder

# Für Build & tesseract-sys (Header) + OpenSSL (rdkafka)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config clang lld \
      libtesseract-dev libleptonica-dev \
      libssl-dev ca-certificates sccache \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV RUSTUP_TOOLCHAIN=stable \
    RUSTC_WRAPPER=sccache \
    CC=clang \
    CXX=clang++ \
    MALLOC_ARENA_MAX=2

# vollständiger Repo-Kontext wird benötigt (Cargo, Workspace, Sources)
COPY . .

# schneller & reproduzierbar mit Cache-Mounts
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/sccache \
    cargo build --release --package text-extraction \
      --manifest-path services/text-extraction/Cargo.toml --locked \
 && strip /app/target/release/text-extraction || true

############################
# Runtime-Stage
############################
FROM debian:bookworm-slim

# Runtime-Dependencies:
#  - tesseract + Sprachdaten (deu/eng)
#  - poppler-utils (pdftoppm/pdftocairo für Rasterisierung)
#  - libssl3 (rdkafka/openssl)
#  - ca-certificates (TLS)
#  - curl nur für HEALTHCHECK
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu \
      poppler-utils libssl3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    RUST_LOG=info

WORKDIR /usr/local/bin
COPY --from=builder /app/target/release/text-extraction /usr/local/bin/text-extraction

# Non-root für Runtime
RUN useradd -r -u 10001 -g root appuser \
 && chown -R appuser:root /usr/local/bin
USER appuser

# einfacher Liveness-Check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8083/health || exit 1

CMD ["/usr/local/bin/text-extraction"]

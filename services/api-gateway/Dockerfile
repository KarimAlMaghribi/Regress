# ---- Build Stage ----
FROM rust:1.80-slim AS builder

# System-Dependencies
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential pkg-config clang lld libssl-dev ca-certificates tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Cargo-Resolver/Cache vorbereiten (ohne Build)
# - Workspace/Cargo.lock + Paket-Manifest vom api-gateway kopieren
COPY Cargo.toml Cargo.lock ./
COPY services/api-gateway/Cargo.toml services/api-gateway/Cargo.toml

# Nur Dependencies auflösen/cachen (keine Targets nötig)
RUN cargo fetch --locked --manifest-path services/api-gateway/Cargo.toml

# Jetzt erst den gesamten Code (damit obiger Cache maximal greift)
COPY . .

# Speicher-schonendes Build
ENV CARGO_BUILD_JOBS=1 \
    RUSTFLAGS="-C linker=clang -C link-arg=-fuse-ld=lld -C codegen-units=1" \
    CC=clang \
    CXX=clang++ \
    MALLOC_ARENA_MAX=2

# Release-Build nur für das api-gateway, mit minimaler Parallelität
RUN cargo build --release --package api-gateway --manifest-path services/api-gateway/Cargo.toml -j1 --locked

# ---- Runtime Stage ----
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin
COPY --from=builder /usr/src/app/target/release/api-gateway .

EXPOSE 8080
CMD ["./api-gateway"]

# ---- Build Stage ----
FROM rust:1.80-slim AS builder

# Minimal nötige System-Dependencies für den Build
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential pkg-config clang lld libssl-dev ca-certificates tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Erzwinge stable-Toolchain (falls im Repo nightly konfiguriert ist)
ENV RUSTUP_TOOLCHAIN=stable

# RAM-schonende Defaults
ENV CARGO_BUILD_JOBS=1 \
    CC=clang \
    CXX=clang++ \
    MALLOC_ARENA_MAX=2 \
    RUSTFLAGS="-C linker=clang -C link-arg=-fuse-ld=lld -C codegen-units=1 -C debuginfo=0 -C target-cpu=x86-64"

# Gesamten Code kopieren
COPY . .

# Wichtig: explizit mit panic=unwind bauen, um Konflikte mit evtl. panic=abort in Cargo-Profilen zu vermeiden.
# cargo rustc erlaubt zusätzliche rustc-Flags nach dem "--".
RUN cargo rustc --release \
    --package api-gateway \
    --manifest-path services/api-gateway/Cargo.toml \
    -j1 --locked -- \
    -C panic=unwind

# ---- Runtime Stage ----
FROM debian:bookworm-slim AS runtime

# Laufzeit-Dependencies (SSL für openssl, Tesseract falls benötigt)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates tesseract-ocr libssl3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin
COPY --from=builder /app/target/release/api-gateway .

EXPOSE 8080
CMD ["./api-gateway"]

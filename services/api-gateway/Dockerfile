# ---- Build Stage ----
FROM rust:1.80-slim AS builder

# Speicherschonende Toolchain + Linker
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential pkg-config clang lld libssl-dev ca-certificates tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Erzwinge STABLE (ignoriert rust-toolchain.toml/nightly im Repo)
ENV RUSTUP_TOOLCHAIN=stable

# Aggressive RAM-Drosselung beim Build
ENV CARGO_BUILD_JOBS=1 \
    CARGO_BUILD_INCREMENTAL=false \
    CARGO_TERM_COLOR=never \
    CARGO_PROFILE_RELEASE_LTO=false \
    CARGO_PROFILE_RELEASE_DEBUG=0 \
    CARGO_PROFILE_RELEASE_PANIC=abort \
    RUSTFLAGS="-C linker=clang -C link-arg=-fuse-ld=lld -C codegen-units=1 -C debuginfo=0 -C target-cpu=x86-64 -C prefer-dynamic" \
    CC=clang \
    CXX=clang++ \
    MALLOC_ARENA_MAX=2

# Gesamten Code kopieren (robust gegen Workspace-Spezifika)
COPY . .

# Nur das api-gateway bauen – minimal parallel
RUN cargo build --release --package api-gateway --manifest-path services/api-gateway/Cargo.toml -j1 --locked

# ---- Runtime Stage ----
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin
COPY --from=builder /app/target/release/api-gateway .

EXPOSE 8080
CMD ["./api-gateway"]

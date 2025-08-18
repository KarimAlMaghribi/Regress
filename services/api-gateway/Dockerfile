# ---- Build Stage ----
FROM rust:1.80-slim AS builder

# RAM-schonender Linker & Build-Tools
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential pkg-config clang lld libssl-dev ca-certificates tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Stable kompromisslos erzwingen (über alles, inkl. rust-toolchain.toml)
ENV RUSTUP_TOOLCHAIN=stable
RUN rustup toolchain install stable && rustup default stable && rustup override set stable

# Projekt kopieren
COPY . .

# Low-Memory Release-Profil direkt im Container setzen (überschreibt Repo-Defaults nur im Build)
RUN mkdir -p .cargo && printf '\
[build]\n\
jobs = 1\n\
\n\
[target.x86_64-unknown-linux-gnu]\n\
linker = "clang"\n\
rustflags = ["-C","link-arg=-fuse-ld=lld","-C","codegen-units=1","-C","debuginfo=0"]\n\
\n\
[profile.release]\n\
opt-level = 1\n\
codegen-units = 1\n\
debug = 0\n\
lto = "off"\n\
panic = "unwind"\n\
incremental = false\n' > .cargo/config.toml

# Weitere RAM-Schoner
ENV CC=clang \
    CXX=clang++ \
    MALLOC_ARENA_MAX=2

# Build: stable + minimal parallel
RUN RUSTUP_TOOLCHAIN=stable cargo +stable build \
    --release \
    --package api-gateway \
    --manifest-path services/api-gateway/Cargo.toml \
    --locked -j 1

# ---- Runtime Stage ----
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates tesseract-ocr libssl3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/local/bin
COPY --from=builder /app/target/release/api-gateway .

EXPOSE 8080
CMD ["./api-gateway"]

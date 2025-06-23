FROM rust:1.72 as builder
WORKDIR /app
COPY ../../Cargo.toml ../../shared/Cargo.toml ./
COPY ../../shared ./shared
COPY . .
RUN cargo build --release

FROM debian:buster-slim
COPY --from=builder /app/target/release/prompt-manager /usr/local/bin/prompt-manager
CMD ["prompt-manager"]

FROM rust:1.72 as builder
WORKDIR /app
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
COPY services/prompt-manager ./services/prompt-manager
RUN cargo build --release --package prompt-manager --manifest-path services/prompt-manager/Cargo.toml

FROM debian:buster-slim
COPY --from=builder /app/target/release/prompt-manager /usr/local/bin/prompt-manager
CMD ["prompt-manager"]

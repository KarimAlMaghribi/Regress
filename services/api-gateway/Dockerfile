FROM rust:1.72 as builder
WORKDIR /app
# Copy workspace files and only the api-gateway crate
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
COPY services/api-gateway ./services/api-gateway
RUN cargo build --release --package api-gateway --manifest-path services/api-gateway/Cargo.toml

FROM debian:buster-slim
COPY --from=builder /app/target/release/api-gateway /usr/local/bin/api-gateway
CMD ["api-gateway"]

FROM rustlang/rust:nightly as builder
WORKDIR /app
# Copy workspace files and only the api-gateway crate
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
# Copy all service crates so the workspace is complete
COPY services ./services
RUN cargo build --release --package api-gateway --manifest-path services/api-gateway/Cargo.toml

FROM debian:bookworm-slim
COPY --from=builder /app/target/release/api-gateway /usr/local/bin/api-gateway
CMD ["api-gateway"]

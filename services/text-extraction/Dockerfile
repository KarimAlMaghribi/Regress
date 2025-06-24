FROM rust:1.78 as builder
WORKDIR /app
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
# Copy all service crates so the workspace is complete
COPY services ./services
RUN cargo build --release --package text-extraction --manifest-path services/text-extraction/Cargo.toml

FROM debian:buster-slim
COPY --from=builder /app/target/release/text-extraction /usr/local/bin/text-extraction
CMD ["text-extraction"]

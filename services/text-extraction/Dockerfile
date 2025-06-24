FROM rust:1.72 as builder
WORKDIR /app
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
COPY services/text-extraction ./services/text-extraction
RUN cargo build --release --package text-extraction --manifest-path services/text-extraction/Cargo.toml

FROM debian:buster-slim
COPY --from=builder /app/target/release/text-extraction /usr/local/bin/text-extraction
CMD ["text-extraction"]

FROM rust:1.72 as builder
WORKDIR /app
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
COPY services/classifier ./services/classifier
RUN cargo build --release --package classifier --manifest-path services/classifier/Cargo.toml

FROM debian:buster-slim
COPY --from=builder /app/target/release/classifier /usr/local/bin/classifier
CMD ["classifier"]

FROM rustlang/rust:nightly as builder
WORKDIR /app
COPY Cargo.toml ./Cargo.toml
COPY shared ./shared
# Copy all service crates so the workspace is complete
COPY services ./services
RUN cargo build --release --package classifier --manifest-path services/classifier/Cargo.toml

FROM debian:buster-slim
COPY --from=builder /app/target/release/classifier /usr/local/bin/classifier
CMD ["classifier"]

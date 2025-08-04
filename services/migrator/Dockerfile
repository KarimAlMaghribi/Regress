FROM rust:1-slim

# Install sqlx-cli with Postgres+Rustls support
RUN cargo install sqlx-cli --no-default-features --features rustls,postgres

WORKDIR /app
COPY migrations ./migrations

# Run migrations and exit
ENTRYPOINT ["sqlx", "migrate", "run"]

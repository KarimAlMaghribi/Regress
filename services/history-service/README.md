# History Service

Consumes Kafka events and stores classification history in PostgreSQL. Provides a REST API and WebSocket for retrieving history updates.

## Usage

1. Build the workspace with `cargo build --release` or use Docker.
2. Start the service with `cargo run -p history-service` or the container image.

The service exposes:
- `GET /classifications?limit=50` – list recent classifications.
- `GET /analyses?status=running` – list analyses by status.
- WebSocket on `/` – sends the last 50 entries on connect and pushes new ones in real time.

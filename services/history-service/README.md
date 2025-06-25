# History Service

Consumes `classification-result` Kafka topic, stores entries in `classification_history` table, and exposes REST and WebSocket APIs.

## Usage

1. Copy `config.example.json` to `.env` or specify via `CONFIG` env variable.
2. Run `npm install` inside this directory.
3. Start service with `npm start`.

The server exposes:
- `GET /classifications?limit=50` – list recent classifications.
- WebSocket at the same host – sends the last 50 entries on connect and pushes new ones in real time.

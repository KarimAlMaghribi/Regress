# Regress

Microservice system for PDF classification using Rust.
For a German overview, see [docs/PROJECT_DOC_DE.md](docs/PROJECT_DOC_DE.md).


```mermaid
graph TD;
    A[API Gateway] -->|upload| B[PDF Ingest];
    B --> C[Text Extraction];
    C --> D[Classifier];
    D --> E[Prompt Manager];
    D --> F[Metrics];
```

## Building

The `text-extraction` service depends on the native
Tesseract OCR library. When building on Windows, install
both **leptonica** and **tesseract** via `vcpkg`:

```powershell
vcpkg install leptonica:x64-windows-static-md \
               tesseract:x64-windows-static-md
```

The CI workflow installs these packages automatically.

## Configuration

All services read the database connection string from the `DATABASE_URL` environment variable.
Kafka connection is read from `MESSAGE_BROKER_URL`.
If either variable is omitted, the code falls back to `postgres://regressdb%40regress-db-develop:cu5u.AVC%3F9055l@regress-db-develop.postgres.database.azure.com:5432/allianz?sslmode=require` and `kafka:9092` respectively.
When running the services outside of Docker you must set `DATABASE_URL` to the Azure server:

```bash
export DATABASE_URL="postgres://regressdb%40regress-db-develop:cu5u.AVC%3F9055l@regress-db-develop.postgres.database.azure.com:5432/allianz?sslmode=require"
```
To connect to an Azure Database for PostgreSQL Flexible Server, provide the full connection string via `DATABASE_URL`. Example:

```bash
export DATABASE_URL="postgres://regressdb%40regress-db-develop:<YOUR_PASSWORD>@regress-db-develop.postgres.database.azure.com:5432/allianz?sslmode=require"
```
Failure to connect to the database results in `500 Internal Server Error`
responses when accessing `/prompts`.
Pipeline execution requires `OPENAI_API_KEY` for calling the OpenAI API.
Defaults are provided in `docker-compose.yml`. The metrics service reads from the same database.

## Usage

1. Upload a PDF via `POST http://localhost:8081/upload` with a multipart field
   named `file`. The response contains the generated id.
2. The `text-extraction` service processes the file asynchronously and publishes
   a `text-extracted` event.
3. The `pipeline-runner` consumes that event, executes the configured pipeline
   and stores the result in the `analysis_history` table. Poll
   `GET http://localhost:8090/results/{id}` until data is returned. The endpoint
   returns `202 Accepted` while processing is still pending.
4. To re-run classification on already extracted texts, first fetch available
   ids via `GET http://localhost:8083/texts` and then submit them to
   `POST http://localhost:8083/analyze` together with a prompt. The endpoint does
   not repeat OCR but simply republishes a `text-extracted` event to start
   classification again.

The `prompt-manager` reads the database connection string from `DATABASE_URL`.
If the variable is not supplied it defaults to
`postgres://regressdb%40regress-db-develop:cu5u.AVC%3F9055l@regress-db-develop.postgres.database.azure.com:5432/allianz?sslmode=require`.
`/prompts` exposes all stored prompts and the table is created automatically if
it does not exist. The same service now also manages pipelines. Use `/pipelines`
to list and create pipelines or `/pipelines/{id}` to update and delete them.

## Running with Docker

Build and start all services, including the frontend, via Docker Compose:

```bash
docker compose up --build
```

1. Ensure Docker and Docker Compose are installed.
2. Run `docker compose up --build` to build all images and start the services.
3. Access the frontend at <http://localhost:3000>.
4. Metrics are available at <http://localhost:8085/metrics>.
5. History service runs at <http://localhost:8090>.
6. Kafka UI is accessible at <http://localhost:8086> for browsing topics and viewing messages.

After the build completes, open <http://localhost:3000> in your browser to use the application.

The frontend expects these environment variables:
`VITE_INGEST_URL` for the upload service (defaults to `http://localhost:8081`),
`VITE_API_URL` for the pipeline API (defaults to `http://localhost:8084`),
`VITE_HISTORY_URL` for the history API (defaults to `http://localhost:8090`) and
`VITE_HISTORY_WS` for the history WebSocket (defaults to `ws://localhost:8090`).


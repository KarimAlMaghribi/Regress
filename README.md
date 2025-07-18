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
The pipeline runner additionally requires `OPENAI_API_KEY` to access the OpenAI API.
It uses the active pipeline from the pipeline-manager when processing events.
Defaults are provided in `docker-compose.yml`. The metrics service reads from the same database.
The text-extraction service triggers a pipeline run via the URL specified in
`PIPELINE_RUN_URL`. Docker Compose sets this variable to
`http://pipeline-runner:8084/pipeline/run?persist=true`.

## Usage

1. Upload a PDF via `POST http://localhost:8081/upload` with a multipart field
   named `file`. The response contains the generated id.
2. The `text-extraction` service processes the file asynchronously and publishes
   a `text-extracted` event.
3. The `pipeline-runner` consumes that event, runs the active pipeline using
   OpenAI and stores the result in the `pipeline_runs` and `prompt_results` tables.
   Poll `GET http://localhost:8084/runs/{id}` until data is returned.
4. To re-run classification on already extracted texts, first fetch available
   ids via `GET http://localhost:8083/texts` and then submit them to
   `POST http://localhost:8083/analyze` together with a prompt. The endpoint does
   not repeat OCR but simply republishes a `text-extracted` event to start
   classification again.

The `prompt-manager` reads the database connection string from `DATABASE_URL`.
If the variable is not supplied it defaults to
`postgres://regressdb%40regress-db-develop:cu5u.AVC%3F9055l@regress-db-develop.postgres.database.azure.com:5432/allianz?sslmode=require`.
`/prompts` exposes all stored prompts and the table is created automatically if
it does not exist.

The `pipeline-manager` provides `/pipelines` to list and create pipelines or
`/pipelines/{id}` to update and delete them.

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

The frontend expects four environment variables:
`VITE_INGEST_URL` for the upload service (defaults to `http://localhost:8081`),
`VITE_CLASSIFIER_URL` for the pipeline-runner service (defaults to
`http://localhost:8084`), `VITE_PROMPT_MANAGER_URL` for the prompt-manager
service (defaults to `http://localhost:8082`), and `VITE_HISTORY_WS` for the
history WebSocket (defaults to `ws://localhost:8090`).


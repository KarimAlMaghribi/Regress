# Regress

Microservice system for PDF classification using Rust.
For a German overview, see [docs/PROJECT_DOC_DE.md](docs/PROJECT_DOC_DE.md).


```mermaid
graph TD;
    A[API Gateway] -->|upload| B[PDF Ingest];
    B --> C[Text Extraction];
    C --> D[Pipeline Runner];
    D --> E[Prompt Manager];
    D --> F[Metrics];
```

## Architecture

* **api-gateway** – performs health checks and forwards requests to the internal services.
* **pdf-ingest** – stores uploaded PDFs and triggers text extraction.
* **text-extraction** – runs OCR on new files and stores the text in the database.
* **pipeline-runner** – consumes `pipeline-run` events, loads the stored text, executes the configured pipeline and emits `pipeline-result`.
* **prompt-manager** – persists prompts and pipelines.
* **pipeline-api** – REST API for editing and executing pipelines.
* **metrics** – exposes Prometheus metrics and a `/health` route.
* **history-service** – records all runs and provides a WebSocket for live updates.

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
If either variable is omitted, the code falls back to `postgres://regress:nITj%22%2B0%28f89F@localhost:5432/regress` and `kafka:9092` respectively.
When running the services outside of Docker you must set `DATABASE_URL` to the server:

```bash
export DATABASE_URL="postgres://regress:nITj%22%2B0%28f89F@localhost:5432/regress"
```
To override the password or connect to a different host, supply the full connection string via `DATABASE_URL`. Example:

```bash
export DATABASE_URL="postgres://regress:<YOUR_PASSWORD>@localhost:5432/regress"
```
Failure to connect to the database results in `500 Internal Server Error`
responses when accessing `/prompts`.
Pipeline execution requires `OPENAI_API_KEY` for calling the OpenAI API.
Defaults are provided in `docker-compose.yml`. The metrics service reads from the same database.

## Usage

1. Upload a PDF via `POST http://localhost:8081/upload` with a multipart field
   named `file`. The response contains the generated id.
2. The `text-extraction` service processes the file asynchronously and stores
   the extracted text in the `pdf_texts` table.
3. Trigger a pipeline run by calling
   `POST http://localhost:8084/pipelines/{id}/run` with
   `{ "file_id": <upload id> }`. The request publishes a `pipeline-run` event.
4. The `pipeline-runner` consumes that event, loads the text from the database,
   executes the configured pipeline and stores the result in the
   `analysis_history` table. Use
   `GET http://localhost:8090/analyses?status=completed` or open the WebSocket on
   the same port to receive updates while processing is running.

The `prompt-manager` reads the database connection string from `DATABASE_URL`.
If the variable is not supplied it defaults to
`postgres://regress:nITj%22%2B0%28f89F@localhost:5432/regress`.
`/prompts` exposes all stored prompts and the table is created automatically if
it does not exist. The same service now also manages pipelines. Use `/pipelines`
to list and create pipelines or `/pipelines/{id}` to update and delete them.
The `pipeline-api` also checks for the `pipelines` table on startup and creates
it if necessary, so migrations do not need to be run manually.

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
6. Kafka UI is accessible at <http://localhost:8086> and automatically connects to the local Kafka broker for browsing topics and viewing messages.
7. Pipeline API is available at <http://localhost:8084>.

After the build completes, open <http://localhost:3000> in your browser to use the application.

The frontend expects these environment variables:
`VITE_INGEST_URL` for the upload service (defaults to `http://localhost:8081`),
`VITE_API_URL` for the pipeline API (defaults to `http://localhost:8084`),
`VITE_HISTORY_URL` for the history API (defaults to `http://localhost:8090`) and
`VITE_HISTORY_WS` for the history WebSocket (defaults to `ws://localhost:8090`).


## CI Pipeline Optimizations

### Was wurde optimiert?
- Dockerfiles nutzen BuildKit, `docker buildx` und einen Registry-Layer-Cache.
- Rust-Builds laufen mit stabilem Toolchain, `sccache` und speicherschonendem Profil aus `.cargo/config.toml`.
- Frontend nutzt `npm ci` mit Cache-Mount, wodurch keine dev-server-Abhängigkeiten installiert werden.

### Wie funktionieren die Caches?
- `cargo`- und Git-Dependencies werden in BuildKit-Cache-Mounts (`/usr/local/cargo/registry`, `/usr/local/cargo/git`) gespeichert.
- `sccache` liegt unter `/sccache` und beschleunigt erneute Builds.
- `docker buildx` nutzt einen lokalen Cache (`.buildx-cache`) und synchronisiert einen Inline-Cache mit `$CI_REGISTRY_IMAGE/cache:*`.
- Node-Module werden über einen NPM-Cache (`/root/.npm`) wiederverwendet.

### Cache gezielt invalidieren
- Änderungen an `Cargo.lock` oder `package-lock.json` erzeugen neue Cache-Schlüssel.
- Zum vollständigen Leeren die Cache-Images `registry/cache:*` löschen oder das Pipeline-Variable `CACHE_BUST` setzen.

### Rollback
- Mit `CI_LOW_MEM=false` können Builds wieder mit mehr Parallelität und Optimierungen ausgeführt werden; dazu die entsprechenden Build-Args setzen oder `.cargo/config.toml` überschreiben.

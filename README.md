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


## Pipelines

Pipelines describe how a sequence of prompts is executed by the `pipeline-runner`. Each
prompt node has a `type` that determines its role in the chain. Supported types are
`TriggerPrompt`, `AnalysisPrompt`, `FollowUpPrompt`, `DecisionPrompt`, `FinalPrompt`
and `MetaPrompt`.

Nodes are connected via edges. An edge may specify a `type` such as `always`,
`onTrue`, `onFalse`, `onScore` or `onError` and an optional `condition` expression.
The runner traverses edges only when the condition matches the result of the
source node.

Stages group multiple prompts together. Each stage can define a `scoreFormula`
that combines the weighted scores of its prompts. After all stages are processed
`finalScoring` evaluates its own `scoreFormula` and applies `labelRules` to
produce the final result.

### Defining and uploading pipelines

A pipeline definition is a JSON document matching the `PipelineGraph` schema.
Send it to the pipeline-manager via:

```bash
curl -X POST http://localhost:8087/pipelines \
  -H 'Content-Type: application/json' \
  -d @pipeline.json
```

The most recently created pipeline is considered active. Retrieve it using
`GET /pipelines/active`. Editing or deleting a pipeline uses
`PUT /pipelines/{id}` and `DELETE /pipelines/{id}`.

### How pipeline-runner works

The `pipeline-runner` subscribes to `layout-extracted` events from Kafka. For
each event it fetches the active pipeline from the pipeline-manager, executes
all prompts using OpenAI and stores the intermediate results in the
`prompt_results` table. The aggregated outcome is written to
`pipeline_runs` and published as a `pipeline-result` event.

### Example pipeline

```json
{
  "nodes": [
    { "id": "start", "text": "Trigger", "type": "TriggerPrompt" },
    { "id": "analysis", "text": "Analyse Text", "type": "AnalysisPrompt", "weight": 1.0 },
    { "id": "final", "text": "Ergebnis", "type": "FinalPrompt" }
  ],
  "edges": [
    { "source": "start", "target": "analysis", "type": "always" },
    { "source": "analysis", "target": "final", "type": "onScore", "condition": "score >= 0.6" }
  ],
  "stages": [
    { "id": "analysis", "name": "Analyse", "promptIds": ["analysis"], "scoreFormula": null }
  ],
  "finalScoring": {
    "scoreFormula": "analysis.score",
    "labelRules": [
      { "if": "score >= 0.6", "label": "OK" },
      { "if": "score < 0.6", "label": "NOT_OK" }
    ]
  }
}
```

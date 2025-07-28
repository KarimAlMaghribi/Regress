# Data Flow Overview

This document lists the data fields captured in the UI, how they are
processed by backend services and where they are stored.

## Upload
- **file** (`File`): selected PDF uploaded from the browser.

The file is sent to the `pdf-ingest` service at `/upload`. It stores the bytes
and publishes a `pdf-merged` event. The other services react on this event:

1. `text-extraction` retrieves the PDF, performs OCR and publishes a
   `text-extracted` message.
2. `pipeline-runner` consumes that message, executes the pipeline and writes to
   the `analysis_history` table before emitting `pipeline-result`.

The `classifications` table contains:

| column       | type      | description                     |
|--------------|-----------|---------------------------------|
| `id`         | SERIAL    | primary key                     |
| `run_time`   | TIMESTAMPTZ | time of classification        |
| `file_name`  | TEXT      | original file name              |
| `prompts`    | TEXT      | comma separated prompt ids      |
| `regress`    | BOOLEAN   | classification result           |
| `metrics`    | JSONB     | analysis metrics                |
| `error`      | TEXT      | error message if classification failed |

Results can be polled via `GET /results/{id}` from the pipeline API.
While processing, the endpoint responds with HTTP `202 Accepted` so callers
should retry until a `200 OK` payload is returned. If an error occurs during
classification the endpoint responds with `500` and includes an `error`
field in the JSON body.

## Prompts
- **text** (`string`): managed in the Prompts page and persisted by the
  `prompt-manager` service in table `prompts(id SERIAL, text TEXT,
  prompt_type TEXT, weight REAL, favorite BOOLEAN)`.
- **type** (`ExtractionPrompt` | `ScoringPrompt` | `DecisionPrompt`): defines the
  role of a prompt and is stored persistently.
- **weight** (`float`): controls how strongly a prompt influences the overall
  classification score. Higher values increase the prompt's impact.

## Frontend Integration
- The ingestion service base URL is read from `VITE_INGEST_URL` and defaults to
  `http://localhost:8081`.
- The pipeline API base URL is configured via `VITE_API_URL` and
  defaults to `http://localhost:8090`.

## Example Request
```
POST /upload
Content-Type: multipart/form-data

file=<pdf bytes>
```

Example response:
```
{ "id": "42" }
```

Poll result:
```
GET /results/42
```
The request returns `202 Accepted` until the classification record exists.

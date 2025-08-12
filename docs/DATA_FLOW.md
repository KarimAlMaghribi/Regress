# Data Flow Overview

This document lists the data fields captured in the UI, how they are
processed by backend services and where they are stored.

## Upload
- **file** (`File`): selected PDF uploaded from the browser.

The file is sent to the `pdf-ingest` service at `/upload`. It stores the bytes
and publishes a `pdf-merged` event. The `text-extraction` service reacts on this
event, performs OCR and stores the text in the database.

A pipeline run is triggered via the pipeline API. It emits a `pipeline-run`
event which the `pipeline-runner` consumes. The runner loads the stored text,
executes the pipeline and writes to the `analysis_history` table before
emitting `pipeline-result`.

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

Finished results are stored in the `analysis_history` table. They can be
retrieved via the history API, e.g.
`GET /analyses?status=completed`. The `/` WebSocket of the same service sends
new entries as soon as they are written. When triggering analyses through the
pipeline API at `/pipelines/{id}/run`, the request returns the result JSON once
available or HTTP `202` while still pending.

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
  defaults to `http://localhost:8084`.
- History queries use `VITE_HISTORY_URL` which defaults to
  `http://localhost:8090`.

## Example Request
```
POST /upload
Content-Type: multipart/form-data

file=<pdf bytes>
```

Example response when triggering a run manually:
```
POST /pipelines/<PIPELINE_ID>/run
{ "file_id": 42 }
```
The request will return either the result JSON or `202 Accepted` until the
`pipeline-result` event is received. Completed runs are also available via the
history API as described above.

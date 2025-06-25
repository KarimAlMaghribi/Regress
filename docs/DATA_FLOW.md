# Data Flow Overview

This document lists the data fields captured in the UI, how they are
processed by backend services and where they are stored.

## Upload
- **file** (`File`): selected PDF uploaded from the browser.

The file is sent to the `pdf-ingest` service at `/upload`. It stores the bytes
and publishes a `pdf-uploaded` event. The other services react on this event:

1. `text-extraction` retrieves the PDF, performs OCR and publishes a
   `text-extracted` message.
2. `classifier` consumes that message, calls OpenAI and writes to the
   `classifications` table before emitting `classification-result`.

The `classifications` table contains:

| column       | type      | description                     |
|--------------|-----------|---------------------------------|
| `id`         | SERIAL    | primary key                     |
| `run_time`   | TIMESTAMPTZ | time of classification        |
| `file_name`  | TEXT      | original file name              |
| `prompts`    | TEXT      | comma separated prompt ids      |
| `regress`    | BOOLEAN   | classification result           |
| `metrics`    | JSONB     | analysis metrics                |

A result can be polled via `GET /results/{id}` from the classifier service.
While processing, the endpoint responds with HTTP `202 Accepted` so callers
should retry until a `200 OK` payload is returned.

## Prompts
- **text** (`string`): managed in the Prompts page and persisted by the
  `prompt-manager` service in table `prompts(id SERIAL, text TEXT)`.

## Frontend Integration
- The ingestion service base URL is read from `VITE_INGEST_URL` and defaults to
  `http://localhost:8081`.
- The classifier service base URL is configured via `VITE_CLASSIFIER_URL` and
  defaults to `http://localhost:8084`.

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

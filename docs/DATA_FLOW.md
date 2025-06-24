# Data Flow Overview

This document lists the data fields captured in the UI, how they are
processed by backend services and where they are stored.

## Upload
- **file** (`File`): selected PDF uploaded from the browser.
- **prompts** (`string[]`): list of prompt texts applied during classification.

These fields are sent to the `classifier` service at `/classify` which now
stores the following columns in the `classifications` table:

| column       | type      | description                     |
|--------------|-----------|---------------------------------|
| `id`         | SERIAL    | primary key                     |
| `run_time`   | TIMESTAMPTZ | time of classification        |
| `file_name`  | TEXT      | original file name              |
| `prompts`    | TEXT      | comma separated prompt texts    |
| `regress`    | BOOLEAN   | classification result           |
| `metrics`    | JSONB     | analysis metrics                |

A list of stored records can be fetched via `GET /history`.

## Prompts
- **text** (`string`): managed in the Prompts page and persisted by the
  `prompt-manager` service in table `prompts(id SERIAL, text TEXT)`.

## Frontend Hooks
- `useAnalysisHistory` loads records from the classifier service using the
  base URL defined by `VITE_CLASSIFIER_URL` (defaults to
  `http://localhost:8084`) and exposes them to the `AnalysisHistory` page.

## Example Request
```
POST /classify
Content-Type: multipart/form-data

file=<pdf data>
prompts=fraud,duplicate
```

Example response:
```
{ "regress": true }
```

Fetching history:
```
GET /history
```
Response:
```
[
  {
    "id": 1,
    "promptId": "fraud,duplicate",
    "pdfFilenames": ["claim.pdf"],
    "runTime": "2024-06-24T12:00:00Z",
    "metrics": { "accuracy": 1.0, "cost": 0.0, "hallucinationRate": 0.0 }
  }
]
```

# Regress

Microservice system for PDF classification using Rust.

```mermaid
graph TD;
    A[API Gateway] -->|upload| B[PDF Ingest];
    B --> C[Text Extraction];
    C --> D[Classifier];
    D --> E[Prompt Manager];
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

## Usage

`text-extraction` expects the path to a PDF either as the first command line
argument or via the `PDF_PATH` environment variable. The `classifier` expects
an `OPENAI_API_KEY` environment variable.

The `prompt-manager` reads the database connection string from `DATABASE_URL`.
Without this variable it falls back to a local SQLite file `prompts.db`. When
running via Docker Compose, a `postgres:15` container is started and the service
connects to it using `postgres://postgres:postgres@db:5432/regress`.
`/prompts` exposes all stored prompts and the table is created automatically if
it does not exist.

## Running with Docker

Build and start all services, including the frontend, via Docker Compose:

```bash
docker compose up --build
```

After the build completes, open <http://localhost:3000> in your browser to view the dashboard.


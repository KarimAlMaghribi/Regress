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

`text-extraction` now takes the path to a PDF either as the first command line
argument or via the `PDF_PATH` environment variable. The `classifier` expects an
`OPENAI_API_KEY` environment variable.

The `prompt-manager` uses a lightweight SQLite database located at
`prompts.db`. It exposes `/prompts` to retrieve all stored prompts and
automatically creates the table on startup if it does not exist.

## Running with Docker

Build and start all services, including the frontend, via Docker Compose:

```bash
docker compose up --build
```

After the build completes, open <http://localhost:3000> in your browser to view the dashboard.

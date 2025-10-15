# SharePoint Ingest Service

Rust-basierter Microservice zum Einsammeln von SharePoint-Ordnern als „Anlagen“, dem Zusammenführen der enthaltenen PDFs und dem Hochladen über die bestehende Upload-API.

## Features

- MS Graph App-Only (client credentials, Sites.Selected) Zugriff
- Steuerbare Jobs (start, pause, resume, cancel, retry) mit In-Memory-State
- Reihenfolge der PDF-Merges konfigurierbar (alphabetisch oder benutzerdefinierte Dateiliste)
- Robust gegen Transienten (Retries, Idempotente Moves)
- Strukturierte JSON-Logs mit `job_id`-Kontext
- Admin-API optional per Bearer-Token abgesichert
- Healthcheck `/healthz`

## Build & Run

```bash
# lokale Entwicklung
INGRESS_PORT=8080 \
TENANT_ID=<tenant> \
CLIENT_ID=<app-id> \
CLIENT_SECRET=<secret> \
UPLOAD_URL=https://example/upload \
cargo run --release -p sharepoint-ingest
```

> Hinweis: Der Service liest alle weiteren Variablen aus der Umgebung (siehe Tabelle unten).

### Docker

```bash
docker build -t regress-sharepoint-ingest services/sharepoint-ingest

docker run --rm -p 8080:8080 \
  -e INGRESS_PORT=8080 \
  -e TENANT_ID=... \
  -e CLIENT_ID=... \
  -e CLIENT_SECRET=... \
  -e UPLOAD_URL=https://example/upload \
  regress-sharepoint-ingest
```

### Wichtige Umgebungsvariablen

| Variable | Beschreibung | Default |
| --- | --- | --- |
| `TENANT_ID` | Azure AD Tenant ID | – |
| `CLIENT_ID` | Graph App ID | – |
| `CLIENT_SECRET` | Client Secret | – |
| `SITE_HOST` | SharePoint Host | `o365adessogroup.sharepoint.com` |
| `SITE_PATH` | SharePoint Site Pfad | `/sites/Regress-Allianz` |
| `INPUT_FOLDER` | Quellordner innerhalb der Standardbibliothek | `Input` |
| `PROCESSED_FOLDER` | Zielordner für erfolgreiche Jobs | `Processed` |
| `FAILED_FOLDER` | Zielordner für fehlgeschlagene Jobs | `Failed` |
| `UPLOAD_URL` | Bestehende Upload-API (Multipart) | – |
| `UPLOAD_API_TOKEN` | Optionales Bearer Token für Upload | – |
| `ADMIN_TOKEN` | Optionales Admin-API Token | – |
| `CORS_ORIGINS` | Kommaseparierte Liste erlaubter Origins | – (fällt auf "*" zurück) |
| `MAX_CONCURRENCY` | Maximale parallele Jobs | `4` |
| `INGRESS_PORT` | HTTP-Port | `8080` |
| `HTTP_BIND` | Bind Adresse | `0.0.0.0` |

### Beispiel Graph Grant (PnP PowerShell)

```powershell
Grant-PnPAzureADAppSitePermission -AppId <CLIENT_ID> -Site https://o365adessogroup.sharepoint.com/sites/Regress-Allianz -Permissions Write
```

## API Quickstart

Alle Endpunkte liefern/erwarten JSON. Bei gesetztem `ADMIN_TOKEN` muss `Authorization: Bearer <token>` gesetzt werden.

- `GET /healthz` – einfacher Healthcheck
- `GET /folders` – listet Unterordner im Input-Verzeichnis
- `POST /jobs` – startet Jobs für ausgewählte Ordner
- `GET /jobs` – aktueller Jobstatus
- `POST /jobs/{id}/pause|resume|cancel|retry`

### Beispiel mit `curl`

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8080/healthz

curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8080/folders

curl -X POST http://localhost:8080/jobs \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"folder_ids":["0123456789"],"order":"alpha"}'
```

Weitere Beispiele finden sich unter [`examples/http.http`](./examples/http.http).

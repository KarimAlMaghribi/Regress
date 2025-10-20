# Regress

Microservice-Plattform zur Klassifikation und Analyse von PDF-Dokumenten. Die Applikation besteht aus mehreren Rust-Services, einem React/Vite-Frontend sowie einer PostgreSQL-Datenbank und Kafka als Event-Bus.

## Inhaltsverzeichnis

1. [Projektüberblick](#projektüberblick)
2. [Onboarding-Checkliste](#onboarding-checkliste)
3. [Repository-Struktur](#repository-struktur)
4. [Architektur](#architektur)
5. [Datenfluss & Kafka-Topics](#datenfluss--kafka-topics)
6. [Schnellstart mit Docker Compose](#schnellstart-mit-docker-compose)
7. [Lokale Entwicklung ohne Docker](#lokale-entwicklung-ohne-docker)
8. [Konfiguration & Umgebungsvariablen](#konfiguration--umgebungsvariablen)
9. [Services im Detail](#services-im-detail)
10. [Persistenz & Migrationen](#persistenz--migrationen)
11. [Tests & Qualitätssicherung](#tests--qualitätssicherung)
12. [Coding-Standards & Tooling](#coding-standards--tooling)
13. [Deployment & Betrieb](#deployment--betrieb)
14. [Fehlerbehebung & Tipps](#fehlerbehebung--tipps)
15. [Weiterführende Dokumente](#weiterführende-dokumente)

## Projektüberblick

Regress verarbeitet eingehende PDF-Dateien (z. B. Schadenmeldungen oder Vertragsunterlagen), extrahiert strukturierte Inhalte und bewertet sie anhand konfigurierbarer KI-Pipelines. Das Frontend stellt Uploads, Pipeline-Läufe, Entscheidungen und Kennzahlen transparent dar. Die Verarbeitungsschritte sind als eigenständige Rust-Microservices umgesetzt, die lose über Kafka-Events gekoppelt sind; Postgres dient als persistenter Speicher für Uploads, Zwischenergebnisse, Pipelines, Historie, Prompts und Metriken.

Der Fokus der Plattform liegt darauf, neue Pipelines schnell zu modellieren, historische Ergebnisse nachvollziehbar zu machen und die KI-Ausgaben für Sachbearbeiter:innen erklärbar aufzubereiten. Für neue Teammitglieder bedeutet das: Rust-Services, Kafka-Events, Azure OpenAI-Aufrufe und das React/Vite-Frontend greifen eng ineinander.

## Onboarding-Checkliste

Folgender Fahrplan hat sich für neue Entwickler:innen bewährt. Hake die Punkte in der genannten Reihenfolge ab, um innerhalb der ersten Tage einsatzfähig zu sein:

1. **Zugänge & Secrets**
   - Git-Zugriff, internes Docker-Registry-Login (`docker.adesso.claims`) und Azure-/OpenAI-Zugangsdaten über das Team einholen.
   - `OPENAI_API_KEY`, optionale SharePoint-Testzugänge sowie Zugang zu Monitoring (Grafana/Prometheus) im Passwortsafe ablegen.
2. **Repository verstehen**
   - Diese README vollständig lesen und danach `docs/DATA_FLOW.md` sowie `docs/pipeline-api.md` überfliegen.
   - In `shared/` die DTOs (`dto.rs`) und Kafka-Hilfsfunktionen ansehen, um ein Gefühl für die Events zu bekommen.
3. **Lokale Umgebung vorbereiten**
   - Docker Desktop bzw. Podman installieren (mind. 6 GB RAM), Rust-Toolchain (`rustup`) und Node.js ≥ 18 bereitstellen.
   - Falls ohne Docker entwickelt wird: lokale Postgres- und Kafka-Instanzen gemäß [Lokale Entwicklung](#lokale-entwicklung-ohne-docker) starten.
4. **Smoke-Test durchführen**
   - `docker compose -f docker-compose.local.yml up --build` ausführen.
   - Über das Frontend einen Beispiel-PDF-Upload testen und prüfen, ob ein Pipeline-Lauf sowie die Historie erscheinen.
5. **Arbeitsbereiche auswählen**
   - Fokus-Service clonen: `services/<name>/src` im Editor öffnen, `cargo run -p <name>` lokal starten und mit Breakpoints/debugging vertraut machen.
   - Frontend in einem zweiten Terminal mit `npm run dev` starten; HTTP-Endpoints via Browser oder eigene REST-Clients (Thunder Client/Postman) nachvollziehen.
6. **Beitrag vorbereiten**
   - Für Rust-Code `cargo fmt`, `cargo clippy --workspace --all-targets` und `cargo test --workspace` laufen lassen.
   - Für das Frontend `npm run test` und optional `npx eslint .` ausführen.
   - Merge Request inkl. CI-Ergebnissen und manuellen Tests dokumentieren.

Tipp: Die wöchentliche Entwickler-Runde nutzt häufig das Kafka-UI (`http://localhost:18086`), um Event-Payloads zwischen Services zu kontrollieren.

## Repository-Struktur

| Pfad | Beschreibung |
| --- | --- |
| `services/` | Rust-Microservices (siehe [Services im Detail](#services-im-detail)). |
| `shared/` | Gemeinsame Rust-Bibliothek mit DTOs, Kafka-Topics, Konfiguration und Azure-OpenAI-Client. |
| `frontend/` | React/Vite-Frontend zur Verwaltung von Uploads, Pipelines und Ergebnissen. |
| `frontend-history/` | Archiv alter UI-Prototypen als Referenz für UX-Entscheidungen. |
| `migrations/` | SQL-Skripte und Skript `run.sh` zum Ausführen von Datenbankmigrationen. |
| `docs/` | Zusatzdokumentation (u. a. Datenfluss & Pipeline-API). |
| `helm/` | Helm-Chart zur Auslieferung des Stacks in Kubernetes-Umgebungen. |
| `.github/workflows/` | GitHub-Automationen (z. B. Dependabot) – ergänzend zur produktiven GitLab-CI. |
| `.gitlab-ci.yml` | Build-Pipeline für Container-Images und Migrationen. |
| `assets/` | Statische Dateien (Logos, Beispiel-PDFs). |
| `docker-compose.*.yml` | Compose-Definitionen für lokale Entwicklung bzw. Produktion. |

## Architektur

```mermaid
graph TD;
    subgraph Clients
        UI[Frontend]
        Ext[SharePoint Ingest]
    end

    UI -->|Upload| GW[API Gateway]
    GW --> UP[Upload API]
    UP -->|persist| DB[(PostgreSQL)]
    UP -->|event| KF[(Kafka)]

    Ext --> SP[SharePoint-Ingest]
    SP -->|event| KF

    KF --> PI[pdf-ingest]
    PI --> TE[text-extraction]
    TE --> DB
    KF --> PR[pipeline-runner]
    PR --> DB
    PR --> MET[metrics]
    PR --> HIST[history-service]
    MET --> DB
    HIST --> DB
    GW --> PM[prompt-manager]
    UI -->|manage pipelines| PA[pipeline-api]
    PA --> DB
    PA --> KF
    PM --> DB
    HIST -->|WebSocket| UI
```

Die genauen Nachrichtentypen und Speicherorte der Daten sind im Dokument [docs/DATA_FLOW.md](docs/DATA_FLOW.md) beschrieben.

## Datenfluss & Kafka-Topics

Die Services sind so entkoppelt, dass jeder Verarbeitungsschritt seine Ergebnisse per Kafka publiziert. Für Debugging und Regressionstests lohnt es sich, den Ablauf einmal bewusst durchzugehen:

1. **Upload**
   - `upload-api` legt einen Eintrag in `uploads` an, persistiert die Rohdatei im Dateisystem und stößt optional direkt eine Pipeline via `pipeline-api` an.
   - `pdf-ingest` verarbeitet Dateien, die über das Gateway oder SharePoint eingeliefert wurden, und sendet nach erfolgreicher Persistierung ein `PdfUploaded`-Event.
2. **Extraktion**
   - `text-extraction` konsumiert `pdf-merged`/`PdfUploaded`, führt OCR via Tesseract aus und publiziert ein `text-extracted`-Event (`TextExtracted`-Payload in [`shared/src/dto.rs`](shared/src/dto.rs)).
3. **Pipeline-Lauf**
   - `pipeline-api` erzeugt `pipeline-run`-Events mit der vollständigen [`PipelineConfig`](shared/src/dto.rs) und dem zugehörigen PDF.
   - `pipeline-runner` konsolidiert OpenAI-Antworten, schreibt Ergebnisse in Postgres (`pipeline_runs`, `pipeline_results`) und sendet `pipeline-result`.
4. **Historisierung & UI**
   - `history-service` konsumiert `pipeline-result` und aktualisiert seine Materialized Views, stellt REST-/WebSocket-Endpoints bereit und beliefert das Frontend in Echtzeit.
   - `metrics` aggregiert Laufzeiten sowie Entscheidungskennzahlen und exponiert sie als Prometheus-Metriken.

| Topic | Produzent | Konsumenten | Payload (siehe [`shared/src/dto.rs`](shared/src/dto.rs)) | Hinweise |
| --- | --- | --- | --- | --- |
| `pdf-merged` | `pdf-ingest`, `sharepoint-ingest` | `text-extraction`, `history-service` | `PdfUploaded` | Wird erzeugt, sobald ein PDF im Dateisystem und der DB vorliegt. |
| `text-extracted` | `text-extraction` | `pipeline-runner`, `history-service` | `TextExtracted` | Enthält den OCR-Text und bildet die Grundlage für nachfolgende Prompts. |
| `pipeline-run` | `pipeline-api` | `pipeline-runner` | `PdfUploaded` + `PipelineConfig` | Startsignal für komplette Pipeline-Läufe. |
| `pipeline-result` | `pipeline-runner` | `history-service`, `metrics` | `PipelineRunResult` | Finale Entscheidungen, Scores, Rohantworten und Log-Schritte. |

Zusätzlich nutzt `prompt-manager` keine Kafka-Topics, sondern wird direkt über REST durch Frontend und Pipeline-Runner angesprochen. Falls du neue Topics einführst, ergänze sie in `shared::kafka::ensure_topics` und dokumentiere sie in [docs/DATA_FLOW.md](docs/DATA_FLOW.md).

## Schnellstart mit Docker Compose

1. **Voraussetzungen**: Docker ≥ 24 inkl. Compose-Plugin, ausreichend RAM (≥ 6 GB) und – für echte LLM-Aufrufe – eine gesetzte `OPENAI_API_KEY`-Variable. Ohne Key laufen Pipelines zwar durch, liefern aber Mock-Ergebnisse.
2. **Umgebung vorbereiten**:
   - Optional: `.env.local` anlegen und `OPENAI_API_KEY=...` sowie weitere Secrets setzen. Compose liest die Werte automatisch ein.
   - Prüfe per `docker login docker.adesso.claims`, dass der Zugriff auf die privaten Images funktioniert.
3. **Stack starten**:
   ```bash
   docker compose -f docker-compose.local.yml up --build
   ```
   Dies startet Postgres, Kafka, alle Rust-Services und das Frontend (Port `3001`). Die Images stammen aus der Registry `docker.adesso.claims` und enthalten vorgebaute Binaries.
4. **Smoke-Check**:
   - Warte, bis `history-service` und `pipeline-runner` in den Logs `started` melden.
   - Öffne <http://localhost:3001> und lade eine PDF-Datei hoch.
   - Beobachte `docker compose logs -f pipeline-runner history-service`, um Event-Verarbeitung und Datenbankzugriffe live zu sehen.
5. **Zugänge**:
   - Frontend: <http://localhost:3001>
   - API Gateway: <http://localhost:8080>
   - Upload API / PDF Ingest: <http://localhost:8081>
   - Pipeline API: <http://localhost:8084>
   - Prompt Manager: <http://localhost:8082>
   - History Service (REST & WS): <http://localhost:8090>
   - Prometheus-Metriken: <http://localhost:8085/metrics>
   - Kafka UI: <http://localhost:18086>
6. **Stoppen & Aufräumen**:
   - `docker compose down` beendet alle Container, belässt aber persistente Volumes.
   - `docker compose down -v` entfernt zusätzlich Daten (nützlich bei Schema-Änderungen).

## Lokale Entwicklung ohne Docker

### Voraussetzungen

| Komponente | Version | Hinweise |
| --- | --- | --- |
| Rust | Nightly (`rustup toolchain install nightly`) | `rust-toolchain.toml` erzwingt Nightly; nutze `cargo +nightly` falls mehrere Toolchains installiert sind. |
| Node.js | ≥ 18 | Für das Vite-Frontend (siehe `frontend/package.json`). |
| PostgreSQL | ≥ 14 | Standard-URL: `postgres://regress:nITj"+0(f89F@localhost:5432/regress`. |
| Kafka | ≥ 3.6 | Lokaler Broker auf `localhost:9092`. |
| Tesseract OCR | 5.x | Benötigt von `text-extraction`. Unter Windows über `vcpkg` installieren. |

### Datenbank & Kafka starten

```bash
# Beispiel mit lokalem Docker (optional)
docker compose -f docker-compose.local.yml up regressdb kafka
```

Alternativ eigene Instanzen betreiben und die Verbindungs-URLs über Umgebungsvariablen setzen (siehe [Konfiguration](#konfiguration--umgebungsvariablen)).

Für reine Host-Installationen empfehlen wir, `postgresql.conf` auf `listen_addresses='*'` zu setzen und den Kafka-Broker mit `KAFKA_CFG_ADVERTISED_LISTENERS=PLAINTEXT://localhost:9092` zu starten.

### Migrationen anwenden

```bash
cd migrations
DATABASE_URL=postgres://regress:nITj"+0(f89F@localhost:5432/regress ./run.sh
```

Das Skript führt alle `_up.sql`- und Standard-SQL-Dateien sequentiell aus und stoppt bei Fehlern. Rückwärtsmigrationen lassen sich mit `MODE=down ./run.sh` anwenden (sofern `_down.sql`-Dateien existieren).

**Tipp:** Für wiederkehrende Aufgaben lohnt sich ein `.env` im Projektwurzel-Verzeichnis, aus dem `direnv` oder `dotenv-linter` die `DATABASE_URL`, `MESSAGE_BROKER_URL` und weitere Variablen automatisch injizieren.

### Services starten

Jeder Service ist ein Cargo-Binary. Typischer Start mit Hot-Reload (via `cargo watch`) sieht so aus:

```bash
cargo run -p api-gateway
cargo run -p pdf-ingest
cargo run -p text-extraction
cargo run -p pipeline-runner
cargo run -p pipeline-api
cargo run -p prompt-manager
cargo run -p metrics
cargo run -p history-service
cargo run -p upload-api
cargo run -p sharepoint-ingest
```

Setze vor dem Start die benötigten Umgebungsvariablen (`DATABASE_URL`, `MESSAGE_BROKER_URL`, `OPENAI_API_KEY` usw.). Eine Übersicht findet sich im Abschnitt [Konfiguration & Umgebungsvariablen](#konfiguration--umgebungsvariablen). Der `pipeline-runner` benötigt zusätzlich Zugriff auf den Prompt-Manager (`PROMPT_MANAGER_URL`).

Empfehlung für schnelles Feedback:

```bash
cargo watch -p pipeline-runner -x 'test -- --nocapture'
cargo watch -p pipeline-runner -x 'run'
```

Nutze `RUST_LOG=debug` (siehe Compose-Dateien) für detailliertere Traces. Logs lassen sich mit `RUST_BACKTRACE=1` ergänzen.

### Frontend entwickeln

```bash
cd frontend
npm install
npm run dev # startet Vite unter http://localhost:5173
```

Für API-Aufrufe liest das Frontend die Vite-Variablen `VITE_INGEST_URL`, `VITE_API_URL`, `VITE_HISTORY_URL` und `VITE_HISTORY_WS`. In der Entwicklung lassen sie sich über eine `.env.local` im `frontend/`-Verzeichnis anpassen.

Weitere nützliche Befehle:

```bash
npm run build   # prüft den Produktionsbuild
npm run test -- --watch # Vitest im Watch-Modus
npx eslint src --max-warnings=0
```

## Konfiguration & Umgebungsvariablen

| Variable | Verwendung | Default / Beispiel |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL-Verbindung für alle Services. | `postgres://regress:nITj"+0(f89F@localhost:5432/regress` (SSL-Modus wird bei Bedarf automatisch deaktiviert). |
| `MESSAGE_BROKER_URL` | Kafka-Bootstrap-Server für Event-Kommunikation. | `kafka:9092` in Docker bzw. `localhost:9092` lokal. |
| `OPENAI_API_KEY` | Authentifizierung für Azure OpenAI Deployments (Pipeline Runner & API). | Keine Standardeinstellung – muss gesetzt sein, wenn echte LLM-Aufrufe erfolgen sollen. |
| `OPENAI_API_BASE` / `OPENAI_CHAT_COMPLETIONS_ENDPOINT` | Überschreibt den Standard-Endpunkt aus [`shared/openai_settings.rs`](shared/src/openai_settings.rs). | Automatisch auf Azure-Deployments gesetzt; nutze eigene Werte für Sandboxes. |
| `OPENAI_DEFAULT_MODEL` | Erzwingt ein bestimmtes Modell für alle Anfragen. | Voreinstellung laut [`DEFAULT_OPENAI_VERSION`](shared/src/openai_settings.rs). |
| `PIPELINE_PAGE_BATCH_SIZE`, `PIPELINE_MAX_PARALLEL`, `PIPELINE_MAX_CHARS`, `PIPELINE_OPENAI_TIMEOUT_MS`, `PIPELINE_OPENAI_RETRIES` | Feinsteuerung des Pipeline-Runners (Batch-Größe, Parallelität, Timeouts, Retry-Zahl). | Siehe Defaults in [`services/pipeline-runner/src/main.rs`](services/pipeline-runner/src/main.rs). |
| `PROMPT_MANAGER_URL` | URL des Prompt-Managers für den Pipeline Runner. | `http://prompt-manager:8082` (Docker). |
| `SERVER_PORT` | Port des History-Service bzw. SharePoint-Ingest (`INGRESS_PORT`). | `8090` bzw. `8080`. |
| `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `SITE_*` | Konfiguration für SharePoint-Ingest (Azure AD + SharePoint-Standort). | Siehe [`services/sharepoint-ingest/src/config.rs`](services/sharepoint-ingest/src/config.rs). |
| `UPLOAD_API_TOKEN`, `ADMIN_TOKEN` | Auth für den Upload-Endpunkt bzw. SharePoint-Steuerung. | Optional; wenn gesetzt, erzwingt der Service Token-Validierung. |
| `RUST_LOG`, `RUST_BACKTRACE` | Logging-Level & Backtrace-Ausgabe. | Beispiele siehe Compose (`info,pipeline_runner=debug`). |
| `VITE_*` | Frontend-Umgebung (Ingest-Service, Pipeline-API, History-API/WebSocket). | Siehe Compose-Definition für Standardwerte. |

Die Pipeline-API kennt mehrere vordefinierte Azure-Deployments und nutzt dabei dieselbe `OPENAI_API_KEY`-Variable.

## Services im Detail

| Service | Ports | Verantwortlichkeiten | Einstieg & Hinweise |
| --- | --- | --- | --- |
| `api-gateway` | 8080 | Reverse Proxy, Health-Checks und CORS-Konfiguration für Frontend-Anfragen. | `services/api-gateway/src/main.rs` routet Endpunkte zu downstream-Services (Uploads, Prompts, Pipelines, SharePoint) und prüft deren Health-Status.【F:services/api-gateway/src/main.rs†L1-L103】 |
| `upload-api` | 8095 | Alternative Upload-Strecke mit SSE-Status-Stream und Simulationen. | Startet mit `HttpServer::new` in `services/upload-api/src/main.rs`, legt `uploads`-Tabelle an und sendet Broadcast-Events an verbundene Clients.【F:services/upload-api/src/main.rs†L1-L120】【F:services/upload-api/src/main.rs†L240-L320】 |
| `pdf-ingest` | 8081 | Persistiert eingehende PDFs, verwaltet Dateisystemspeicher und stößt OCR an. | Nutzt Kafka (`PdfUploaded`) und Postgres; s. `services/pdf-ingest/src/main.rs` für Event-Veröffentlichung.【F:services/pdf-ingest/src/main.rs†L400-L415】 |
| `text-extraction` | 8083 | Führt OCR mit Tesseract aus und erzeugt `text-extracted`. | Bibliothek unter `services/text-extraction/src/lib.rs` startet `tesseract`-Prozesse und veröffentlicht Ergebnisse.【F:services/text-extraction/src/lib.rs†L205-L244】 |
| `pipeline-api` | 8084 | REST-Verwaltung von Pipelines, Trigger neuer Läufe. | Publiziert `pipeline-run` in `services/pipeline-api/src/main.rs` und validiert Pipeline-Konfigurationen.【F:services/pipeline-api/src/main.rs†L679-L716】 |
| `pipeline-runner` | 8087 (intern) | Konsumiert `pipeline-run`, orchestriert OpenAI-Aufrufe, persistiert Ergebnisse. | In `services/pipeline-runner/src/main.rs` werden Kafka-Themen angelegt, Batches konfiguriert und SQLx-Pools aufgebaut.【F:services/pipeline-runner/src/main.rs†L39-L118】 |
| `prompt-manager` | 8082 | CRUD für Prompts und Pipeline-Gruppen inkl. Azure-OpenAI-Deployment-Metadaten. | Siehe `services/prompt-manager/src/` (Axum + SeaORM); interagiert direkt mit dem Frontend und Pipeline-Runner. |
| `metrics` | 8085 | Aggregiert Laufzeiten/Kennzahlen aus Postgres und exponiert Prometheus-kompatible JSON. | `services/metrics/src/main.rs` liefert `/metrics` und `health`, inkl. robuster DB-Verbindung.【F:services/metrics/src/main.rs†L1-L118】【F:services/metrics/src/main.rs†L118-L160】 |
| `history-service` | 8090 | REST + WebSocket für Pipeline-Historie, konsumiert `pdf-merged` & `pipeline-result`. | `services/history-service/src/main.rs` verwaltet Broadcast-Channels und Kafka-Consumer für Live-Updates.【F:services/history-service/src/main.rs†L700-L900】 |
| `sharepoint-ingest` | 8080 (Default) | Scannt definierte SharePoint-Ordner, führt AV-Checks durch und lädt PDFs hoch. | Konfiguration via `services/sharepoint-ingest/src/config.rs`, Einstiegspunkt `main.rs` mit Actix-Web-API und Graph-Client.【F:services/sharepoint-ingest/src/main.rs†L1-L88】【F:services/sharepoint-ingest/src/config.rs†L1-L66】 |

Weitere Details (Handler, Event-Strukturen, DTOs) finden sich im `shared`-Crate und in den jeweiligen Service-`src/`-Verzeichnissen.

## Persistenz & Migrationen

- **Tabellen & Constraints**: Das Basisschema (`migrations/0001_core.sql`) legt Prompts, Pipeline-Definitionen, PDF-Speicher (`merged_pdfs`, `pdf_texts`) und Upload-Status mit Validierungen an.【F:migrations/0001_core.sql†L1-L64】【F:migrations/0001_core.sql†L65-L110】
- **Pipeline-Läufe**: Ergänzende Migrationen erzeugen Lauf- und Ergebnis-Tabellen (`pipeline_runs`, `classifications`) inklusive Views für das Reporting.【F:migrations/0002_runs.sql†L1-L80】
- **Tenants & Defaults**: Spätere Migrationen fügen Mandantenverwaltung (`tenants`) und Default-Zuordnungen hinzu.【F:migrations/0006_tenants.sql†L1-L80】
- **Migration ausführen**: `migrations/run.sh` ruft `psql` sequentiell für alle `_up.sql` und Standarddateien auf; per `MODE=down` können `_down.sql`-Dateien rückwärts ausgeführt werden.【F:migrations/run.sh†L1-L34】
- **Containerisierte Migrationen**: Das `migrations/Dockerfile` baut ein minimales Image, das `run.sh` als Entrypoint nutzt – ideal für CI/CD-Stages (`db-migrate`).【F:migrations/Dockerfile†L1-L8】【F:docker-compose.prod.yml†L9-L24】

Halte Migrationen strikt idempotent, da mehrere Services dieselben Skripte aufrufen können. Dokumentiere größere Schemaänderungen zusätzlich in den Release Notes.

## Tests & Qualitätssicherung

| Bereich | Befehl | Hinweis |
| --- | --- | --- |
| Rust-Services | `cargo +nightly test --workspace` | Führt alle Unit- und Integrationstests der Services sowie des `shared`-Crates aus. |
| Rust-Lints | `cargo +nightly fmt -- --check` & `cargo +nightly clippy --workspace --all-targets -- -D warnings` | Erzwingt Formatierung und behandelt Clippy-Warnungen als Fehler. |
| Frontend-Tests | `npm run test` (im `frontend/`-Ordner) | Nutzt Vitest; `npm run test -- --watch` für kontinuierliches Feedback.【F:frontend/package.json†L5-L17】 |
| Frontend-Lints | `npx eslint src --max-warnings=0` | Stellt sicher, dass TypeScript/React-Regeln eingehalten werden. |
| End-to-End Smoke | `docker compose -f docker-compose.local.yml up --build` | Prüft Zusammenspiel aller Services inklusive Kafka/Postgres. |
| Container-Builds | `docker compose build` bzw. CI-Build-Jobs | Validiert Dockerfiles (siehe `.gitlab-ci.yml`).【F:docker-compose.local.yml†L1-L112】【F:.gitlab-ci.yml†L23-L121】 |

CI-Pipelines verwenden BuildKit, `sccache` und Caching für Rust- und Node-Abhängigkeiten, um Builds zu beschleunigen.

## Coding-Standards & Tooling

- **Rust-Toolchain**: `rust-toolchain.toml` pinnt Nightly – verwende `cargo +nightly ...` oder setze Nightly als Default, damit Formatter & Clippy konsistent laufen.【F:rust-toolchain.toml†L1-L2】
- **Gemeinsame DTOs**: Kafka-Events, REST-Responses und Pipeline-Konfigurationen sind zentral in [`shared/src/dto.rs`](shared/src/dto.rs) definiert. Neue Payloads gehören zuerst hierher, damit alle Services denselben Typ verwenden.【F:shared/src/dto.rs†L1-L120】【F:shared/src/dto.rs†L160-L210】
- **Konfigurationszugriff**: Nutze `shared::config::Settings` für Standardwerte (DB, Kafka) und ergänze servicespezifische Variablen per `std::env::var`. So bleiben Tests reproduzierbar.【F:shared/src/config.rs†L1-L36】
- **Tracing & Fehlerbehandlung**: Verwende `tracing`-Macros (`info!`, `warn!`, `error!`) und `anyhow::Result`/`thiserror` für aussagekräftige Logs. Beispiel: Pipeline-Runner initialisiert Kafka-Topics und Logging vor dem Eventloop.【F:services/pipeline-runner/src/main.rs†L39-L82】
- **OpenAI-Anbindung**: Zentralisierte Modell-/Endpoint-Steuerung liegt in [`shared/src/openai_settings.rs`](shared/src/openai_settings.rs); vermeide Hardcodes in einzelnen Services.【F:shared/src/openai_settings.rs†L1-L48】
- **Frontend-Prinzipien**: React + TypeScript + Vite mit Material UI, Zustand, Axios & Vitest (siehe `frontend/package.json`). Halte State-Management in Stores, Komponenten deklarativ und schreibe Typen mit Zod, wo nötig.【F:frontend/package.json†L1-L37】
- **Automatisierung**: Lege häufig genutzte Befehle in VS Code Tasks oder `justfile` (optional) ab; `cargo doc --open` erzeugt Service-Dokumentation, Postman/Thunder-Collections sollten im Repo versioniert werden.

## Deployment & Betrieb

- **Docker Compose Produktion**: `docker-compose.prod.yml` orchestriert Services inkl. Migrations-Job (`db-migrate`), setzt Health-Retry-Strategien und injiziert produktive URLs (`PDF_INGEST_URL`, `OPENAI_API_KEY`).【F:docker-compose.prod.yml†L1-L80】
- **CI/CD**: `.gitlab-ci.yml` baut alle Images mit Buildx, cached Rust/Node-Abhängigkeiten und pusht nur geänderte Services in `docker.adesso.claims`. Verwende `FORCE_BUILD_ALL=1`, um vollständige Releases zu erzwingen.【F:.gitlab-ci.yml†L17-L121】
- **Helm-Chart**: Das Chart unter `helm/` dient als Ausgangspunkt für Kubernetes-Deployments. Passe `image.repository`, Secrets und Ressourcenlimits in `values.yaml` an.【F:helm/values.yaml†L1-L4】
- **Observability**: `metrics` liefert Prometheus-kompatible Daten, `history-service` streamt Events per WebSocket; kombiniere dies mit zentralem Logging (Loki/Elastic) und verknüpfe Dashboards mit Kafka-UI.
- **Operational Runbooks**: Dokumentiere Rotation von `OPENAI_API_KEY`, SharePoint-Credentials und Datenbankpasswörtern im Team-Wiki. Für Wartungsfenster `docker service update --force` (Swarm) oder `helm upgrade` nutzen.

## Fehlerbehebung & Tipps

- **Datenbankverbindung schlägt fehl**: Prüfe `DATABASE_URL` und stelle sicher, dass `sslmode=disable` gesetzt ist – Services wie `upload-api` ergänzen dies automatisch, falls es fehlt.【F:services/upload-api/src/main.rs†L31-L64】【F:services/upload-api/src/main.rs†L240-L320】
- **Kafka-Topics fehlen**: Der Pipeline-Runner legt Topics beim Start an (`ensure_topics`). Wenn das fehlschlägt, kontrolliere Broker-URL und ACLs; Logs mit `RUST_LOG=debug` aktivieren.【F:services/pipeline-runner/src/main.rs†L39-L82】
- **Kein Kafka**: Ohne Broker blockieren `pdf-ingest`, `text-extraction`, `pipeline-runner` und `history-service`. Starte zuerst Kafka/Postgres (`docker compose up regressdb kafka`) oder setze `MESSAGE_BROKER_URL` auf deine Instanz.【F:docker-compose.local.yml†L1-L112】
- **OCR-Fehler**: Stelle sicher, dass Tesseract + Sprachpakete (`tesseract-ocr-deu`, `tesseract-ocr-eng`) installiert sind; der Service ruft das CLI direkt auf und bricht bei Timeout/Exitcode ab.【F:services/text-extraction/src/lib.rs†L205-L244】
- **SharePoint-Ingest scheitert**: Kontrolliere Azure AD-Credentials (`TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`) sowie Ordnernamen (`INPUT_FOLDER`, `PROCESSED_FOLDER`).【F:services/sharepoint-ingest/src/config.rs†L1-L66】
- **LLM-Aufrufe schlagen fehl**: `OPENAI_API_KEY` setzen und bei Bedarf `OPENAI_API_BASE` oder `OPENAI_CHAT_COMPLETIONS_ENDPOINT` anpassen (siehe OpenAI-Settings).【F:shared/src/openai_settings.rs†L1-L48】

## Weiterführende Dokumente

- [Deutschsprachige Projektbeschreibung](docs/PROJECT_DOC_DE.md)
- [Datenfluss im Detail](docs/DATA_FLOW.md)
- [Pipeline- und Prompt-API](docs/pipeline-api.md)

Diese README bietet einen Einstieg; für tiefergehende Informationen lohnt sich ein Blick in die jeweiligen Service-Module und Docstrings (`cargo doc --open`).

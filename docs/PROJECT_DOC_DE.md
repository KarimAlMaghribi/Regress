# Gesamtüberblick über das Projekt

Dieses Dokument beschreibt das Projekt **Regress** auf Deutsch und gibt einen praktischen Überblick über die einzelnen Komponenten.

## Ziel des Systems

Regress ist ein verteiltes Microservice-System zur Klassifikation von PDF-Dateien. Hochgeladene Dokumente werden automatisch verarbeitet und anhand definierter Prompt-Vorlagen bewertet. Das Ergebnis kann anschließend über eine API abgefragt werden.

## Architektur

Das System besteht aus mehreren Diensten, die über Docker Compose gestartet werden können. Die Kommunikation zwischen den Services erfolgt über HTTP und Kafka. Die wichtigsten Dienste sind:

- **api-gateway** – bündelt sämtliche Endpunkte und leitet Anfragen an die internen Services weiter.
- **pdf-ingest** – nimmt hochgeladene PDFs entgegen, speichert sie und löst das Extrahieren des Textes aus.
- **text-extraction** – führt OCR aus und übergibt den erkannten Text an den Pipeline-Runner.
- **pipeline-runner** – führt die Pipeline aus und speichert das Ergebnis in der Datenbank.
- **pipeline-api** – bietet eine REST-Schnittstelle zum Bearbeiten und
  Ausführen von Pipelines. Ein Lauf kann über
  `POST /pipelines/{id}/run` gestartet werden.
- **prompt-manager** – verwaltet Prompt-Vorlagen und Pipelines.
- **metrics** – stellt Metriken und eine Health-Route bereit.
- **history-service** – liefert via WebSocket den Verlauf vergangener Klassifikationen.

Die Ergebnisse jeder Analyse werden in der Tabelle `analysis_history`
gespeichert. Über die History-API können sie per
`GET /analyses?status=completed` abgefragt oder in Echtzeit über den
WebSocket-Endpoint `/` verfolgt werden.

Eine schematische Darstellung findet sich in der README-Datei im Wurzelverzeichnis.

## Aufbau und Start

Voraussetzungen:

- Rust und Cargo
- Docker und Docker Compose

Zum Starten aller Services kann folgender Befehl verwendet werden:

```bash
docker compose up --build
```

Danach ist das Frontend unter <http://localhost:3000> erreichbar. Die REST-Endpunkte befinden sich standardmäßig auf den Ports 8081 bis 8085. Die History-WebSocket läuft auf Port 8090.

## Datenfluss

Eine detaillierte Beschreibung des Datenflusses (Upload, Extraktion und Klassifikation) befindet sich in `docs/DATA_FLOW.md`.

## Praktische Tipps

1. **Entwicklung**: Jeder Dienst enthält ein eigenes `Cargo.toml`. Änderungen können separat kompiliert und getestet werden.
2. **Konfiguration**: Datenbank- und Kafka-URLs können über Umgebungsvariablen angepasst werden. Beispielwerte sind in `docker-compose.yml` hinterlegt.
3. **Erweiterbarkeit**: Neue Dienste lassen sich leicht hinzufügen. Wichtig ist, dass sie ihre Health-Route implementieren, damit das Gateway den Zustand prüfen kann.
4. **Azure-Checks**: Hinweise zur Überprüfung der Azure-OpenAI-Anbindung und zum Aktivieren detaillierter Logs stehen in `docs/azure-openai-debugging.md`.


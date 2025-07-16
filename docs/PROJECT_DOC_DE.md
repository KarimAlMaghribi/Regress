# Gesamtüberblick über das Projekt

Dieses Dokument beschreibt das Projekt **Regress** auf Deutsch und gibt einen praktischen Überblick über die einzelnen Komponenten.

## Ziel des Systems

Regress ist ein verteiltes Microservice-System zur Klassifikation von PDF-Dateien. Hochgeladene Dokumente werden automatisch verarbeitet und anhand definierter Prompt-Vorlagen bewertet. Das Ergebnis kann anschließend über eine API abgefragt werden.

## Architektur

Das System besteht aus mehreren Diensten, die über Docker Compose gestartet werden können. Die Kommunikation zwischen den Services erfolgt über HTTP und Kafka. Die wichtigsten Dienste sind:

- **api-gateway** – bündelt sämtliche Endpunkte und leitet Anfragen an die internen Services weiter.
- **pdf-ingest** – nimmt hochgeladene PDFs entgegen, speichert sie und löst das Extrahieren des Textes aus.
- **text-extraction** – führt OCR aus und übergibt den erkannten Text an den Classifier.
- **classifier** – ruft OpenAI auf und speichert die Klassifikation samt Metriken in der Datenbank.
- **prompt-manager** – verwaltet Prompt-Vorlagen und Pipelines für den Classifier.
- **metrics** – stellt Metriken und eine Health-Route bereit.
- **history-service** – liefert via WebSocket den Verlauf vergangener Klassifikationen.

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


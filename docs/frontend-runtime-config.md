# Frontend Runtime-Konfiguration und Upload-Endpunkt

Der gebaute Vite-Build liest zur Laufzeit optional eine `env.js` und befüllt
`window.__ENV__`. Für Upload- und SharePoint-Aufrufe werden diese Werte vor den
Build-Defaults ausgewertet.【F:frontend/src/utils/api.ts†L13-L52】【F:frontend/src/utils/ingestApi.ts†L18-L96】

## SharePoint-Upload
Der SharePoint-Client verarbeitet mehrere Variablennamen (`SHAREPOINT_INGEST_URL`,
`SHAREPOINT_INGEST_API_URL`, `INGEST_URL` …) und vereinheitlicht sie mit
`normalizeSharePointBase`. Host-Only-Werte werden dabei automatisch auf den
Pfad `/ingest` abgebildet, sodass das Frontend immer den relativen Endpunkt der
aktuellen Origin nutzt.【F:frontend/src/utils/ingestApi.ts†L32-L106】

Damit der Browser exakt diesen Pfad ausliefert, sollten sowohl die Portainer-
Config `frontend_env_js_v5` (für `window.__ENV__`) als auch die Vite-Variablen
auf `/ingest` zeigen. Im Compose-Setup des Frontends ist dieser Pfad bereits als
Default hinterlegt.【F:docker-compose.prod.yml†L108-L116】

## PDF-Upload
Für PDF-Ingest greift das Frontend weiterhin auf die dedizierten Variablen
`PDF_INGEST_URL` und Konsorten zurück. Diese werden zwar ebenfalls normalisiert,
behalten aber ihren eigenen Port (8081) und bleiben von der SharePoint-Anpassung
unberührt.【F:frontend/src/utils/api.ts†L36-L78】

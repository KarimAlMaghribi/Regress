# Frontend Runtime-Konfiguration und Upload-Endpunkt

Der gebaute Vite-Build liest zur Laufzeit eine optionale Datei `env.js`. Sie wird
beim Start über `frontend_env_js_v2` nach `/usr/share/nginx/html/env.js`
injiziert und setzt `window.__ENV__`. Sobald dort ein Wert für `INGEST_URL`
oder `INGEST_API_URL` steht, benutzt `frontend/src/utils/api.ts` genau diesen
Basis-Pfad für alle Upload-Aufrufe, bevor es auf die Vite-Defaults oder den
Fallback zur aktuellen Origin zurückfällt.【F:frontend/src/utils/api.ts†L36-L47】

Im Compose-Setup der Produktivumgebung verweist der Frontend-Container auf die
Config `frontend_env_js_v2` und übernimmt außerdem das Environment `PUBLIC_HOST`
mit dem Standard `helium.adesso.claims`. Dadurch bleibt in `env.js`
regelmäßig ein Hostname eingetragen, selbst wenn das Frontend später über eine
IP-Adresse ausgeliefert wird.【F:docker-compose.prod.yml†L95-L113】

Das GitLab-CI-Template definiert zusätzlich die Variable `INGEST_PORT` mit dem
Default `8091`. Aus dieser Kombination entsteht zur Laufzeit der Wert
`https://helium.adesso.claims:8091`, der unverändert an den Browser ausgeliefert
wird.【F:.gitlab-ci.yml†L20-L24】 Da weder die NGINX-`sub_filter`-Regeln noch der
Browser diesen Host auflösen können, enden Requests an `/uploads` in einem
`net::ERR_NAME_NOT_RESOLVED`.

## Auswirkungen
- Alle Upload-Komponenten (Dateiliste, PDF-Links, SharePoint-Status) binden den
  falschen Host, solange `window.__ENV__.INGEST_URL` gefüllt ist.
- Der Fallback auf die aktuelle Origin (`http://<host>:8080`) greift nur, wenn
  die Werte aus `env.js` entfernt oder leer sind.

## Maßnahmen zur Behebung
1. **Konfigurationswert anpassen:** Stelle sicher, dass `frontend_env_js_v2`
   einen erreichbaren Host enthält – z. B. die öffentliche IP mit Port 8080
   oder den pfadbasierten Proxy `/ingest`.
2. **PUBLIC_HOST überschreiben:** Falls der Container mit einem anderen Host
   ausgeliefert wird, setze `PUBLIC_HOST` bereits im Deployment auf den
   gewünschten Wert.
3. **Port im CI korrigieren:** Passe `INGEST_PORT` (oder die daraus abgeleiteten
   Variablen) in GitLab an, damit neue Builds automatisch den richtigen Port
   verwenden.
4. **Fallback aktivieren:** Soll die App immer die aktuelle Origin nutzen,
   entferne `frontend_env_js_v2` aus dem Deployment oder lasse `INGEST_URL`
   bewusst leer.

Nach diesen Schritten liest das Frontend entweder die aktualisierte URL oder
fällt auf den automatischen Fallback (`resolveDefaultIngestBase`) zurück, womit
alle `/uploads`-Aufrufe am korrekten Endpoint landen.【F:frontend/src/utils/defaultIngestUrl.ts†L1-L18】

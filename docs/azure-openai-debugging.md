# Azure OpenAI Überprüfung und Debugging

Dieser Leitfaden beschreibt, wie du kontrollieren kannst, ob die Dienste tatsächlich Azure OpenAI ansprechen und wie du detaillierte Debug-Logs aktivierst.

## 1. Konfiguration prüfen

Beim Start lädt der Pipeline-Runner die gespeicherten OpenAI-Einstellungen und schreibt nun einen Log-Eintrag der Form

```
INFO  configured OpenAI defaults{version=..., requested_model=..., resolved_model=..., endpoint=..., endpoint_kind=..., auth=..., is_azure=...}
```

* `endpoint` zeigt den endgültigen Ziel-Endpunkt an.
* `auth` ist `api_key`, sobald Azure-Authentifizierung aktiv ist.
* `is_azure` steht auf `true`, wenn die URL auf `*.openai.azure.com` verweist.

Damit lässt sich beim Hochfahren eindeutig erkennen, ob Azure OpenAI angesprochen wird.

## 2. Debug-Logs aktivieren

Das Tracing-Setup nutzt `EnvFilter::from_default_env()`. Setze vor dem Start des Pipeline-Runners beispielsweise

```bash
RUST_LOG=info,shared::openai_client=debug
```

Dadurch bleiben die bisherigen `info`-Logs erhalten, zusätzlich erscheinen aber die Debug-Ausgaben des OpenAI-Clients.

## 3. Request/Response im Log kontrollieren

Mit aktiviertem Debug-Level protokolliert `call_openai_chat`

```
→ OpenAI request: model = ...
← headers = {...}
← body[0..512] = ...
```

Diese Zeilen zeigen das angesprochene Deployment, den HTTP-Status und die ersten 512 Byte der Antwort. Sobald sie erscheinen, weißt du, dass Azure OpenAI erreichbar ist und antwortet.

## 4. Fehlerfall erkennen

* Netzwerkfehler erzeugen einen `error!`-Eintrag: `network error to OpenAI: ...`.
* Antworten, die kein gültiges JSON enthalten, resultieren in `warn!`-Logs wie `invalid JSON fragment ...` oder `missing structured JSON content ...`. Diese Meldungen enthalten einen Ausschnitt der Modellantwort und belegen, dass der Dienst antwortet, aber das Format nicht den Erwartungen entspricht.

Mit diesen Logs lässt sich schnell beurteilen, ob Azure korrekt angesprochen wurde und warum ein Prompt ggf. fehlgeschlagen ist.

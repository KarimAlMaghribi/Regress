# SharePoint Automation Defaults

Global SharePoint automation defaults allow operators to toggle automation for entire tabs in the SharePoint ingest UI instead of enabling folders one by one. Two scopes are supported:

- `ingest`: Controls automatic job creation for folders arriving in the **Anlagen** tab.
- `processing`: Controls automatic pipeline starts for completed uploads that appear in the **Verarbeitung** tab.

Each scope stores whether it is enabled along with optional identifiers that are required when the scope is active. The configuration lives in the `sharepoint_automation_defaults` table and integrates with the existing folder automation table through the `managed_by_default` flag.

## API Endpoints

The ingest service now exposes dedicated endpoints for querying and updating default settings:

- `GET /automation/settings` returns all default configurations.
- `PUT /automation/settings/{scope}` updates a single scope. Only `ingest` and `processing` are accepted.

When enabling ingest defaults you must provide `tenant_id`. When enabling processing defaults you must provide `pipeline_id`. Payloads omit identifiers when disabling automation, leaving existing values untouched for later reuse.

## Poller Behaviour

During each automation poll cycle the service loads both folder rules and defaults. If ingest defaults are enabled, the poller ensures that every visible SharePoint folder has an automation rule marked `managed_by_default`. Newly discovered folders receive rules that mirror the global tenant (and optional pipeline) selection, while previously default-managed folders are updated to keep their metadata and timestamps fresh. Disabling ingest defaults removes any `managed_by_default` rules without touching manual ones.

Jobs spawned from these defaults are flagged as `auto_managed` and post an "Automatischer Import (global) gestartet" message so the UI can distinguish globally triggered runs.

Processing defaults focus on pipeline execution. Whenever the default is enabled with a pipeline identifier, the poller scans for SharePoint jobs whose uploads are ready, lack a pipeline assignment, and have no existing pipeline run. Matching jobs receive a `pipeline_id`, get a global status message, and trigger `pipeline.start_run` automatically.

## Manual Job Creation

The `POST /automation/jobs` endpoint continues to support manual job creation. If the ingest default is enabled and the incoming request omits explicit `tenant_id` or `pipeline_id` overrides, the service injects the global defaults so that on-demand jobs stay aligned with the tab configuration.

## UI Integration

The SharePoint upload UI now focuses on the global switches at the top of the **Anlagen** and **Verarbeitung** tabs. These controls call the default-setting endpoints and surface the currently active tenant or pipeline selection. Folder rows only show read-only chips that indicate whether an entry follows the global defaults (labelled "Global") or represents a historical override. Per-folder switches and dropdowns have been removed in favour of inline helper texts that point operators to the relevant tab-level toggle.

## Operational Notes

- Defaults are stored with timestamps, allowing administrators to audit changes.
- Disabling a scope keeps previously configured identifiers so that re-enabling automation restores them automatically.
- Manually created folder rules always override defaults and are preserved across toggles.

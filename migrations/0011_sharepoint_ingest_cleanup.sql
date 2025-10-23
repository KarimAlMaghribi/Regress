SET search_path TO public;

-- Remove auto pipeline flags from default-managed SharePoint automation rules.
UPDATE sharepoint_automation
SET auto_pipeline = FALSE,
    pipeline_id = NULL,
    updated_at = now()
WHERE auto_pipeline = TRUE
  AND managed_by_default = TRUE;

-- Ensure ingest defaults do not keep stale pipeline assignments.
UPDATE sharepoint_automation_defaults
SET pipeline_id = NULL,
    updated_at = now()
WHERE scope = 'ingest'
  AND pipeline_id IS NOT NULL;

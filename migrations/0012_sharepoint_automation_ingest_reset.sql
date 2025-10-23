SET search_path TO public;

-- Disable automatic pipeline assignments for existing ingest automation rules.
UPDATE sharepoint_automation
SET pipeline_id = NULL,
    auto_pipeline = FALSE,
    updated_at = now()
WHERE auto_ingest = TRUE
  AND (pipeline_id IS NOT NULL OR auto_pipeline = TRUE);

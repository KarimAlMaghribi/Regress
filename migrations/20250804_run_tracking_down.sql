BEGIN;
DROP INDEX IF EXISTS idx_pipeline_run_steps_run_id;
DROP INDEX IF EXISTS idx_pipeline_runs_finished_at;
DROP INDEX IF EXISTS idx_pipeline_runs_started_at;
DROP INDEX IF EXISTS idx_pipeline_runs_pdf_id;
DROP INDEX IF EXISTS idx_pipeline_runs_pipeline_id;

DROP TABLE IF EXISTS pipeline_run_steps;
DROP TABLE IF EXISTS pipeline_runs;
COMMIT;

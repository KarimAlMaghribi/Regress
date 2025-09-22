-- Vorsicht: destruktiv. Entfernt bekannte alte/abgelehnte Strukturen.
DO $$
DECLARE
r RECORD;
BEGIN
FOR r IN
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
                    'run_extractions','run_scores','run_decisions',
                    'analysis_history','pipeline_step_attempts','pipeline_run_steps',
                    'pipeline_runs','pipeline_steps','pipelines','prompts',
                    'pdf_texts','pdf_files'
    )
    LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
END LOOP;
END$$;

-- Vorsicht: destruktiv. Entfernt bekannte alte/abgelehnte Strukturen.
DO $$
DECLARE
r RECORD;
BEGIN
FOR r IN
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    -- Altlasten (falls vorhanden)
                    'run_extractions','run_scores','run_decisions',
    -- Lauf-/Historientabellen
                    'analysis_history','pipeline_step_attempts','pipeline_run_steps','pipeline_runs',
    -- Definitions- und Mappings
                    'pipeline_steps','pipelines',
                    'group_prompts','prompt_groups','prompts',
    -- Dateien/Texte
                    'pdf_texts','pdf_files'
    )
    LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
END LOOP;
END$$;

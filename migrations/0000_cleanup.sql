\echo 'ℹ️ cleanup.sql loaded — default is to SKIP. Set -v ALLOW_CLEANUP=1 to enable.'

\if :{?ALLOW_CLEANUP}
\echo '⚠️  Running cleanup (DEV ONLY) … dropping selected tables with CASCADE.'
  DO $$
  DECLARE r RECORD;
BEGIN
FOR r IN
SELECT tablename
FROM pg_tables
WHERE schemaname='public'
  AND tablename IN (
    -- Lauf-/Historientabellen
                    'analysis_history','pipeline_step_attempts','pipeline_run_steps','pipeline_runs',
    -- Definitions- und Mappings
                    'pipeline_steps','pipelines',
                    'group_prompts','prompt_groups','prompts',
    -- Dateien/Texte
                    'pdf_texts','pdf_sources','merged_pdfs',
    -- Uploads
                    'uploads',
    -- Altlasten (falls früher angelegt)
                    'pdf_files','pdfs'
    )
    LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I.%I CASCADE', 'public', r.tablename);
END LOOP;
  END$$;
\else
\echo '⏭️  Skipping cleanup (pass -v ALLOW_CLEANUP=1 to enable).'
\endif

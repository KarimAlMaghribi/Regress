DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipeline_run_steps' AND column_name='merge_to'
  ) THEN
ALTER TABLE pipeline_run_steps ADD COLUMN merge_to TEXT;
END IF;

  -- Wenn diese Felder im Code als non-null erwartet werden, constraint setzen:
ALTER TABLE pipeline_run_steps
    ALTER COLUMN step_id     SET NOT NULL,
ALTER COLUMN prompt_id   SET NOT NULL,
    ALTER COLUMN prompt_type SET NOT NULL,
    ALTER COLUMN result      SET NOT NULL;
END $$;

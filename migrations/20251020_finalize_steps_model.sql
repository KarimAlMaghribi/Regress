-- 20251025_finalize_steps_model.sql
-- Markiert Final-Zeilen in pipeline_run_steps und ergänzt optionale Flat-Columns
-- für schnelle Filterung / UI-Anzeigen.

BEGIN;

ALTER TABLE pipeline_run_steps
    ADD COLUMN IF NOT EXISTS is_final  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS final_key TEXT,
    ADD COLUMN IF NOT EXISTS confidence REAL,
    ADD COLUMN IF NOT EXISTS answer     BOOLEAN,
    ADD COLUMN IF NOT EXISTS route      TEXT,
    ADD COLUMN IF NOT EXISTS page       INT;

-- sinnvolle Indizes
CREATE INDEX IF NOT EXISTS idx_prs_run_final_type
    ON pipeline_run_steps (run_id, is_final, prompt_type);

CREATE INDEX IF NOT EXISTS idx_prs_run_final_key
    ON pipeline_run_steps (run_id, final_key)
    WHERE is_final = TRUE;

COMMIT;

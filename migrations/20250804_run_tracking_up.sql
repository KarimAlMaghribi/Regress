-- 20250804_run_tracking_up.sql
BEGIN;

-- pipeline_runs: Haupttabelle für einen Pipeline-Run
CREATE TABLE IF NOT EXISTS pipeline_runs (
                                             id            UUID PRIMARY KEY,
                                             pipeline_id   UUID        NOT NULL,
                                             pdf_id        INT         NOT NULL,
                                             started_at    TIMESTAMPTZ DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    overall_score REAL,
    extracted     JSONB
    );

-- Fallback: Spalte extracted ergänzen, falls sie in Altbeständen fehlt
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipeline_runs' AND column_name='extracted'
  ) THEN
ALTER TABLE pipeline_runs ADD COLUMN extracted JSONB;
END IF;
END $$;

-- hilfreiche Indizes
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_desc ON pipeline_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pdf_id       ON pipeline_runs (pdf_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_id  ON pipeline_runs (pipeline_id);

-- pipeline_run_steps: per-Step Log / Ergebnisse
CREATE TABLE IF NOT EXISTS pipeline_run_steps (
                                                  run_id       UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    seq_no       INT,
    step_id      TEXT,
    prompt_id    INT,
    prompt_type  TEXT,
    decision_key TEXT,
    route        TEXT,
    result       JSONB,
    created_at   TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (run_id, seq_no)
    );

-- Fallback: route ergänzen, falls Altbestand
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipeline_run_steps' AND column_name='route'
  ) THEN
ALTER TABLE pipeline_run_steps ADD COLUMN route TEXT;
END IF;
END $$;

-- hilfreiche Indizes
CREATE INDEX IF NOT EXISTS idx_prs_run_id        ON pipeline_run_steps (run_id);
CREATE INDEX IF NOT EXISTS idx_prs_run_id_seq_no ON pipeline_run_steps (run_id, seq_no);
CREATE INDEX IF NOT EXISTS idx_prs_created_desc  ON pipeline_run_steps (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prs_prompt_id     ON pipeline_run_steps (prompt_id);

COMMIT;

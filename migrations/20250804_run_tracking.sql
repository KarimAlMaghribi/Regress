BEGIN;

-- 1) pipeline_runs anlegen/ergänzen
CREATE TABLE IF NOT EXISTS pipeline_runs (
                                             id            UUID PRIMARY KEY,
                                             pipeline_id   UUID NOT NULL,
                                             pdf_id        INT  NOT NULL,
                                             started_at    TIMESTAMPTZ DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    overall_score REAL,
    extracted     JSONB
    );

-- Spalten-Guards (falls in Altständen etwas fehlt/anderen Typ hat)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipeline_runs' AND column_name='extracted'
  ) THEN
ALTER TABLE pipeline_runs ADD COLUMN extracted JSONB;
END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipeline_runs' AND column_name='overall_score'
  ) THEN
ALTER TABLE pipeline_runs ADD COLUMN overall_score REAL;
END IF;
END$$;

-- Indizes (runtime-hilfreich)
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_id  ON pipeline_runs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pdf_id       ON pipeline_runs(pdf_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at   ON pipeline_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_finished_at  ON pipeline_runs(finished_at);

-- 2) pipeline_run_steps anlegen/ergänzen
CREATE TABLE IF NOT EXISTS pipeline_run_steps (
                                                  run_id       UUID REFERENCES pipeline_runs (id) ON DELETE CASCADE,
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

-- Kompatibilität: Falls es noch "merge_key" aus Altständen gibt
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipeline_run_steps' AND column_name='merge_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipeline_run_steps' AND column_name='decision_key'
  ) THEN
ALTER TABLE pipeline_run_steps RENAME COLUMN merge_key TO decision_key;
END IF;
END$$;

-- Falls Spalten fehlen, nachziehen
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipeline_run_steps' AND column_name='decision_key'
  ) THEN
ALTER TABLE pipeline_run_steps ADD COLUMN decision_key TEXT;
END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipeline_run_steps' AND column_name='created_at'
  ) THEN
ALTER TABLE pipeline_run_steps ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
END IF;
END$$;

-- Index für häufige Join/Lookup-Pfade
CREATE INDEX IF NOT EXISTS idx_pipeline_run_steps_run_id ON pipeline_run_steps(run_id);

COMMIT;

Optional kannst du dir eine Down-Datei ablegen (nur falls ihr revertet), ebenfalls idempotent:
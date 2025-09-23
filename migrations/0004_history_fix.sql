SET search_path TO public;

-- 0) Sicherstellen, dass die für den History-Service genutzten Spalten existieren
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS pdf_id      INTEGER;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS pipeline_id UUID;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS state       JSONB;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS pdf_url     TEXT;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS "timestamp" TIMESTAMPTZ;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS status      TEXT;
ALTER TABLE analysis_history ALTER COLUMN status SET DEFAULT 'running';
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS score       DOUBLE PRECISION;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS label       TEXT;

-- 1) Kernfix: run_id darf NULL sein (History-Service sendet es nicht)
ALTER TABLE analysis_history
    ALTER COLUMN run_id DROP NOT NULL;

-- 2) FKs idempotent anlegen
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name='analysis_history' AND constraint_name='analysis_history_pdf_id_fkey'
  ) THEN
ALTER TABLE analysis_history
    ADD CONSTRAINT analysis_history_pdf_id_fkey
        FOREIGN KEY (pdf_id) REFERENCES merged_pdfs(id) ON DELETE SET NULL;
END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name='analysis_history' AND constraint_name='analysis_history_pipeline_id_fkey'
  ) THEN
ALTER TABLE analysis_history
    ADD CONSTRAINT analysis_history_pipeline_id_fkey
        FOREIGN KEY (pipeline_id) REFERENCES pipelines(id) ON DELETE SET NULL;
END IF;
END$$;

-- 3) Trigger: fehlende Felder automatisch füllen
CREATE OR REPLACE FUNCTION trg_fill_analysis_history()
RETURNS trigger AS $$
BEGIN
  IF NEW."timestamp" IS NULL THEN
    NEW."timestamp" := now();
END IF;

  -- Wenn run_id fehlt, aber (pdf_id, pipeline_id) vorhanden: neuesten passenden Run nachschlagen
  IF NEW.run_id IS NULL AND NEW.pdf_id IS NOT NULL AND NEW.pipeline_id IS NOT NULL THEN
SELECT id
INTO NEW.run_id
FROM pipeline_runs
WHERE pdf_id = NEW.pdf_id
  AND pipeline_id = NEW.pipeline_id
ORDER BY COALESCE(finished_at, created_at) DESC
    LIMIT 1;
END IF;

  -- Falls run_id gesetzt ist, aber pdf_id/pipeline_id fehlen → aus pipeline_runs nachziehen
  IF NEW.run_id IS NOT NULL THEN
    IF NEW.pdf_id IS NULL THEN
SELECT pdf_id INTO NEW.pdf_id FROM pipeline_runs WHERE id = NEW.run_id;
END IF;
    IF NEW.pipeline_id IS NULL THEN
SELECT pipeline_id INTO NEW.pipeline_id FROM pipeline_runs WHERE id = NEW.run_id;
END IF;
END IF;

RETURN NEW;
END$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_analysis_history_fill') THEN
CREATE TRIGGER trg_analysis_history_fill
    BEFORE INSERT ON analysis_history
    FOR EACH ROW
    EXECUTE FUNCTION trg_fill_analysis_history();
END IF;
END$$;

-- 4) Indexe fürs Trigger-Lookup & typische History-Queries
CREATE INDEX IF NOT EXISTS idx_runs_pdf_pipe_created
    ON pipeline_runs (pdf_id, pipeline_id, COALESCE(finished_at, created_at) DESC);

CREATE INDEX IF NOT EXISTS idx_hist_pdf_ts
    ON analysis_history (pdf_id, "timestamp" DESC);

CREATE INDEX IF NOT EXISTS idx_hist_pipeline_ts
    ON analysis_history (pipeline_id, "timestamp" DESC);

SET search_path TO public;

-- ================= pipeline_runs =================
CREATE TABLE IF NOT EXISTS pipeline_runs (
                                             id               UUID PRIMARY KEY,
                                             pipeline_id      UUID    NOT NULL REFERENCES pipelines(id),
    pdf_id           INTEGER REFERENCES merged_pdfs(id),
    status           TEXT    NOT NULL CHECK (status IN ('queued','running','completed','failed','timeout','canceled')),
    overall_score    NUMERIC(7,3),
    final_extraction JSONB,
    final_scores     JSONB,
    final_decisions  JSONB,
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );

ALTER TABLE pipeline_runs
DROP CONSTRAINT IF EXISTS pipeline_runs_status_check;
ALTER TABLE pipeline_runs
    ADD CONSTRAINT pipeline_runs_status_check
        CHECK (status IN ('queued','running','completed','finished','finalized','failed','timeout','canceled','error'));

-- ================= pipeline_run_steps =================
CREATE TABLE IF NOT EXISTS pipeline_run_steps (
                                                  id                 BIGSERIAL PRIMARY KEY,
                                                  run_id             UUID    NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    pipeline_step_id   BIGINT      REFERENCES pipeline_steps(id)      ON DELETE CASCADE, -- kann NULL sein (final/virtuell)
    step_type          TEXT,                                                             -- Runner liefert das nicht → NULL ok
    status             TEXT    NOT NULL DEFAULT 'finalized' CHECK (status IN ('queued','running','finalized','failed')),
    started_at         TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,

    final_candidate_id BIGINT,
    final_confidence   NUMERIC(6,3),
    final_key          TEXT,
    final_value        JSONB,
    error              TEXT,

    -- Runner-Felder
    seq_no             INT,
    step_id            TEXT,
    prompt_id          INT,
    prompt_type        TEXT,
    decision_key       TEXT,
    route              TEXT,
    result             JSONB,
    is_final           BOOLEAN NOT NULL DEFAULT FALSE,
    confidence         REAL,
    answer             BOOLEAN,
    page               INT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (run_id, pipeline_step_id)
    );

ALTER TABLE pipeline_run_steps ALTER COLUMN step_type DROP NOT NULL;
ALTER TABLE pipeline_run_steps DROP CONSTRAINT IF EXISTS pipeline_run_steps_step_type_check;
ALTER TABLE pipeline_run_steps ALTER COLUMN pipeline_step_id DROP NOT NULL;

UPDATE pipeline_run_steps SET status = 'finalized' WHERE status IS NULL;
ALTER TABLE pipeline_run_steps ALTER COLUMN status SET DEFAULT 'finalized';
ALTER TABLE pipeline_run_steps DROP CONSTRAINT IF EXISTS pipeline_run_steps_status_check;
ALTER TABLE pipeline_run_steps ADD CONSTRAINT pipeline_run_steps_status_check
    CHECK (status IN ('queued','running','finalized','failed'));
ALTER TABLE pipeline_run_steps ALTER COLUMN status SET NOT NULL;

ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS seq_no       INT;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS step_id      TEXT;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS prompt_id    INT;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS prompt_type  TEXT;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS decision_key TEXT;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS route        TEXT;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS result       JSONB;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS is_final     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS confidence   REAL;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS answer       BOOLEAN;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS page         INT;
ALTER TABLE pipeline_run_steps ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE pipeline_run_steps SET seq_no = COALESCE(seq_no, 0);
ALTER TABLE pipeline_run_steps ALTER COLUMN seq_no SET NOT NULL;

-- ================= pipeline_step_attempts =================
CREATE TABLE IF NOT EXISTS pipeline_step_attempts (
                                                      id                   BIGSERIAL PRIMARY KEY,
                                                      run_step_id          BIGINT NOT NULL REFERENCES pipeline_run_steps(id) ON DELETE CASCADE,
    attempt_no           INT    NOT NULL DEFAULT 1,
    candidate_key        TEXT,
    candidate_value      JSONB,
    candidate_confidence NUMERIC(6,3),
    source               TEXT,
    batch_no             INT,
    openai_raw           JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_final             BOOLEAN NOT NULL DEFAULT FALSE
    );

-- ================= analysis_history =================
CREATE TABLE IF NOT EXISTS analysis_history (
                                                id          BIGSERIAL PRIMARY KEY,
                                                run_id      UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    pdf_id      INTEGER,            -- wird per Trigger aus pipeline_runs befüllt, falls NULL
    pipeline_id UUID,               -- dto.
    state       JSONB,              -- Ergebnis (alias 'result')
    pdf_url     TEXT,
    "timestamp" TIMESTAMPTZ,        -- UI-Order (History-Service)
    status      TEXT NOT NULL DEFAULT 'running',
    score       DOUBLE PRECISION,
    label       TEXT,

    event_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type  TEXT CHECK (event_type IN ('RUN_CREATED','STEP_STARTED','STEP_COMPLETED','STEP_FINALIZED','BRANCH_SELECTED','ERROR','FINALIZED')),
    step_index  INT,
    prompt_id   INT REFERENCES prompts(id),
    message     TEXT,
    openai_raw  JSONB,
    route_stack TEXT[]
    );

ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS pdf_id      INTEGER;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS pipeline_id UUID;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS state       JSONB;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS pdf_url     TEXT;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS "timestamp" TIMESTAMPTZ;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS status      TEXT;
ALTER TABLE analysis_history ALTER COLUMN status SET DEFAULT 'running';
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS score       DOUBLE PRECISION;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS label       TEXT;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS event_time  TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS event_type  TEXT;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS step_index  INT;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS message     TEXT;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS openai_raw  JSONB;
ALTER TABLE analysis_history ADD COLUMN IF NOT EXISTS route_stack TEXT[];

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

UPDATE analysis_history ah
SET pdf_id = pr.pdf_id
    FROM pipeline_runs pr
WHERE ah.run_id = pr.id AND ah.pdf_id IS NULL;

UPDATE analysis_history ah
SET pipeline_id = pr.pipeline_id
    FROM pipeline_runs pr
WHERE ah.run_id = pr.id AND ah.pipeline_id IS NULL;

CREATE OR REPLACE FUNCTION trg_fill_analysis_history()
RETURNS trigger AS $$
BEGIN
  IF NEW."timestamp" IS NULL THEN
    NEW."timestamp" := now();
END IF;

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
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_analysis_history_fill') THEN
CREATE TRIGGER trg_analysis_history_fill
    BEFORE INSERT ON analysis_history
    FOR EACH ROW
    EXECUTE FUNCTION trg_fill_analysis_history();
END IF;
END$$;

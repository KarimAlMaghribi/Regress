SET search_path TO public;

-- Lauf-Tabelle
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

-- Runner setzt am Ende 'finalized' ⇒ CHECK-Constraint erweitern (idempotent)
ALTER TABLE pipeline_runs
DROP CONSTRAINT IF EXISTS pipeline_runs_status_check;

ALTER TABLE pipeline_runs
    ADD CONSTRAINT pipeline_runs_status_check
        CHECK (status IN ('queued','running','completed','finalized','failed','timeout','canceled'));

-- Steps pro Run
CREATE TABLE IF NOT EXISTS pipeline_run_steps (
                                                  id                 BIGSERIAL PRIMARY KEY,
                                                  run_id             UUID    NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    pipeline_step_id   BIGINT  NOT NULL REFERENCES pipeline_steps(id) ON DELETE CASCADE,
    step_type          TEXT    NOT NULL CHECK (step_type IN ('Extraction','Score','Decision','Final','Meta')),
    status             TEXT    NOT NULL CHECK (status IN ('queued','running','finalized','failed')),
    started_at         TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,

    final_candidate_id BIGINT,
    final_confidence   NUMERIC(6,3),
    final_key          TEXT,
    final_value        JSONB,
    error              TEXT,

    UNIQUE (run_id, pipeline_step_id)
    );

-- Runner erwartet zusätzliche Spalten (idempotent nachziehen):
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

-- Attempts je Step (feinere Kandidatenebene)
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

-- Verlauf / Events
CREATE TABLE IF NOT EXISTS analysis_history (
                                                id         BIGSERIAL PRIMARY KEY,
                                                run_id     UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type TEXT NOT NULL CHECK (event_type IN
('RUN_CREATED','STEP_STARTED','STEP_COMPLETED','STEP_FINALIZED','BRANCH_SELECTED','ERROR','FINALIZED')),
    step_index INT,
    prompt_id  INT REFERENCES prompts(id),
    status     TEXT,
    message    TEXT,
    openai_raw JSONB,
    route_stack TEXT[]
    );

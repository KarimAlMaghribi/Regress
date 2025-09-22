-- Pipeline-Läufe (Instanz)
CREATE TABLE pipeline_runs (
                               id                UUID PRIMARY KEY,
                               pipeline_id       UUID   NOT NULL REFERENCES pipelines(id),
                               pdf_id            BIGINT NOT NULL REFERENCES pdf_files(id),
                               status            TEXT   NOT NULL CHECK (status IN
                                                                        ('queued','running','completed','failed','timeout','canceled')),
                               overall_score     NUMERIC(7,3),
                               final_extraction  JSONB,                    -- Key→Value (für schnelle UI)
                               final_scores      JSONB,                    -- Key→Score
                               final_decisions   JSONB,                    -- Key→true/false
                               started_at        TIMESTAMPTZ,
                               finished_at       TIMESTAMPTZ,
                               error             TEXT,
                               created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step-Instanz im Run (+ finales Step-Ergebnis)
CREATE TABLE pipeline_run_steps (
                                    id                 BIGSERIAL PRIMARY KEY,
                                    run_id             UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
                                    pipeline_step_id   BIGINT NOT NULL REFERENCES pipeline_steps(id) ON DELETE CASCADE,
                                    step_type          TEXT NOT NULL CHECK (step_type IN ('Extraction','Score','Decision','Final','Meta')),
                                    status             TEXT NOT NULL CHECK (status IN ('queued','running','finalized','failed')),
                                    started_at         TIMESTAMPTZ,
                                    finished_at        TIMESTAMPTZ,

                                    final_candidate_id BIGINT,                  -- optional FK auf pipeline_step_attempts.id (bewusst ohne FK wegen Zyklus)
                                    final_confidence   NUMERIC(6,3),
                                    final_key          TEXT,
                                    final_value        JSONB,                   -- normalisierte Nutzlast (Text/Bool/Zahl/Objekt)
                                    error              TEXT,

                                    UNIQUE (run_id, pipeline_step_id)
);

-- Alle Kandidaten/Versuche eines Steps
CREATE TABLE pipeline_step_attempts (
                                        id                     BIGSERIAL PRIMARY KEY,
                                        run_step_id            BIGINT NOT NULL REFERENCES pipeline_run_steps(id) ON DELETE CASCADE,
                                        attempt_no             INT NOT NULL DEFAULT 1,
                                        candidate_key          TEXT,
                                        candidate_value        JSONB,
                                        candidate_confidence   NUMERIC(6,3),
                                        source                 TEXT,                -- 'llm'|'regex'|'ocr'|'rule'|...
                                        batch_no               INT,
                                        openai_raw             JSONB,
                                        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
                                        is_final               BOOLEAN NOT NULL DEFAULT FALSE
);

-- History/Events (für Live-UI/Debug)
CREATE TABLE analysis_history (
                                  id              BIGSERIAL PRIMARY KEY,
                                  run_id          UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
                                  event_time      TIMESTAMPTZ NOT NULL DEFAULT now(),
                                  event_type      TEXT NOT NULL CHECK (event_type IN
                                                                       ('RUN_CREATED','STEP_STARTED','STEP_COMPLETED','STEP_FINALIZED','BRANCH_SELECTED','ERROR','FINALIZED')),
                                  step_index      INT,
                                  prompt_id       BIGINT,
                                  status          TEXT,
                                  message         TEXT,
                                  openai_raw      JSONB,
                                  route_stack     TEXT[]
);

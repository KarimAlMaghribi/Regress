-- Pipelines (Definition)  ✅ pipeline-api erwartet config_json
DROP TABLE IF EXISTS pipelines CASCADE;

CREATE TABLE pipelines (
                           id           SERIAL PRIMARY KEY,
                           name         TEXT NOT NULL UNIQUE,
                           description  TEXT,
                           version      INT  NOT NULL DEFAULT 1,
                           is_active    BOOLEAN NOT NULL DEFAULT TRUE,
                           config_json  JSONB NOT NULL,          -- <— wichtig für /pl/pipelines
                           created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                           updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schritte innerhalb einer Pipeline
DROP TABLE IF EXISTS pipeline_steps CASCADE;

CREATE TABLE pipeline_steps (
                                id                   BIGSERIAL PRIMARY KEY,
                                pipeline_id          INT  NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
                                order_index          INT  NOT NULL,
                                step_type            TEXT NOT NULL CHECK (step_type IN ('Extraction','Score','Decision','Final','Meta')),
                                prompt_id            INT REFERENCES prompts(id),

    -- Routing:
                                yes_key              TEXT,
                                no_key               TEXT,
                                merge_key            TEXT,

    -- Normalisierung/Qualität:
                                aggregator           TEXT NOT NULL DEFAULT 'MAX_CONFIDENCE'
                                    CHECK (aggregator IN ('MAX_CONFIDENCE','MAJORITY','WEIGHTED_SCORE','RULE_BASED')),
                                min_confidence       NUMERIC(6,3) NOT NULL DEFAULT 0.0,
                                decision_threshold   NUMERIC(6,3),
                                multishot            INT NOT NULL DEFAULT 1,

                                json_key             TEXT,        -- optional Override
                                config               JSONB,

                                UNIQUE (pipeline_id, order_index)
);

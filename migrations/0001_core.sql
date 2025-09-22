-- Dateien + OCR
CREATE TABLE pdf_files (
                           id            BIGSERIAL PRIMARY KEY,
                           sha256        TEXT NOT NULL UNIQUE,
                           filename      TEXT NOT NULL,
                           content_type  TEXT,
                           size_bytes    BIGINT,
                           storage_path  TEXT,
                           source        TEXT,
                           uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pdf_texts (
                           pdf_id        BIGINT NOT NULL REFERENCES pdf_files(id) ON DELETE CASCADE,
                           page_no       INT    NOT NULL,
                           text          TEXT   NOT NULL,
                           ocr_engine    TEXT,
                           lang          TEXT,
                           created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
                           PRIMARY KEY (pdf_id, page_no)
);

-- Prompts (Definition)
CREATE TABLE prompts (
                         id           SERIAL PRIMARY KEY,
                         text         TEXT NOT NULL,
                         prompt_type  TEXT NOT NULL CHECK (prompt_type IN
                                                           ('ExtractionPrompt','ScoringPrompt','DecisionPrompt','FinalPrompt','MetaPrompt')),
                         weight       NUMERIC(6,3),               -- NULL außer bei Scoring/Decision
                         json_key     TEXT,                       -- wichtig fürs Frontend/Mapping
                         favorite     BOOLEAN NOT NULL DEFAULT FALSE,
                         created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                         updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                         CONSTRAINT weight_only_for_weighted
                             CHECK (
                                 (prompt_type IN ('ScoringPrompt','DecisionPrompt') AND weight IS NOT NULL)
                                     OR
                                 (prompt_type NOT IN ('ScoringPrompt','DecisionPrompt') AND weight IS NULL)
                                 )
);

-- Prompt-Gruppen
CREATE TABLE prompt_groups (
                               id           SERIAL PRIMARY KEY,
                               name         TEXT NOT NULL UNIQUE,
                               favorite     BOOLEAN NOT NULL DEFAULT FALSE,
                               created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                               updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- M:N Zuordnung Gruppen <-> Prompts
CREATE TABLE group_prompts (
                               group_id     INT NOT NULL REFERENCES prompt_groups(id) ON DELETE CASCADE,
                               prompt_id    INT NOT NULL REFERENCES prompts(id)       ON DELETE CASCADE,
                               PRIMARY KEY (group_id, prompt_id)
);

-- Pipelines (Definition)
CREATE TABLE pipelines (
                           id           UUID PRIMARY KEY,
                           name         TEXT NOT NULL UNIQUE,
                           description  TEXT,
                           version      INT  NOT NULL DEFAULT 1,
                           is_active    BOOLEAN NOT NULL DEFAULT TRUE,
                           created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
                           updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schritte innerhalb einer Pipeline
CREATE TABLE pipeline_steps (
                                id                   BIGSERIAL PRIMARY KEY,
                                pipeline_id          UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
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

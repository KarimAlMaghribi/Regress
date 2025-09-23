-- Baseline Schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS public;
SET search_path TO public;

-- ===== Prompts & Gruppen =====
CREATE TABLE prompts (
                         id          SERIAL PRIMARY KEY,
                         text        TEXT NOT NULL,
                         prompt_type TEXT NOT NULL CHECK (
                             prompt_type IN ('ExtractionPrompt','ScoringPrompt','DecisionPrompt','FinalPrompt','MetaPrompt')
                             ),
                         weight      NUMERIC(6,3),
                         json_key    TEXT,
                         favorite    BOOLEAN NOT NULL DEFAULT FALSE,
                         CONSTRAINT weight_only_for_weighted CHECK (
                             (prompt_type IN ('ScoringPrompt','DecisionPrompt') AND weight IS NOT NULL)
                                 OR
                             (prompt_type NOT IN ('ScoringPrompt','DecisionPrompt') AND weight IS NULL)
                             )
);

CREATE TABLE prompt_groups (
                               id       SERIAL PRIMARY KEY,
                               name     TEXT NOT NULL UNIQUE,
                               favorite BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE group_prompts (
                               group_id  INTEGER NOT NULL REFERENCES prompt_groups(id) ON DELETE CASCADE,
                               prompt_id INTEGER NOT NULL REFERENCES prompts(id)        ON DELETE CASCADE,
                               PRIMARY KEY (group_id, prompt_id)
);

-- ===== Pipelines (Definition) =====
CREATE TABLE pipelines (
                           id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                           name        TEXT NOT NULL UNIQUE,
                           description TEXT,
                           version     INT  NOT NULL DEFAULT 1,
                           is_active   BOOLEAN NOT NULL DEFAULT TRUE,
                           config_json JSONB NOT NULL,
                           created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
                           updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pipeline_steps (
                                id                 BIGSERIAL PRIMARY KEY,
                                pipeline_id        UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
                                order_index        INT  NOT NULL,
                                step_type          TEXT NOT NULL CHECK (step_type IN ('Extraction','Score','Decision','Final','Meta')),
                                prompt_id          INT REFERENCES prompts(id),

                                yes_key            TEXT,
                                no_key             TEXT,
                                merge_key          TEXT,

                                aggregator         TEXT NOT NULL DEFAULT 'MAX_CONFIDENCE'
                                    CHECK (aggregator IN ('MAX_CONFIDENCE','MAJORITY','WEIGHTED_SCORE','RULE_BASED')),
                                min_confidence     NUMERIC(6,3) NOT NULL DEFAULT 0.0,
                                decision_threshold NUMERIC(6,3),
                                multishot          INT NOT NULL DEFAULT 1,

                                json_key           TEXT,
                                config             JSONB,

                                UNIQUE (pipeline_id, order_index)
);

-- ===== PDFs & Uploads =====
CREATE TABLE merged_pdfs (
                             id         SERIAL PRIMARY KEY,
                             sha256     TEXT    NOT NULL,
                             size_bytes INTEGER NOT NULL,
                             data       BYTEA   NOT NULL
);

CREATE TABLE pdf_sources (
                             pdf_id INTEGER PRIMARY KEY REFERENCES merged_pdfs(id) ON DELETE CASCADE,
                             names  TEXT,
                             count  INTEGER
);

CREATE TABLE pdf_texts (
                           merged_pdf_id INTEGER NOT NULL REFERENCES merged_pdfs(id) ON DELETE CASCADE,
                           page_no       INTEGER NOT NULL,
                           text          TEXT    NOT NULL,
                           PRIMARY KEY (merged_pdf_id, page_no)
);

CREATE TABLE uploads (
                         id          SERIAL PRIMARY KEY,
                         pdf_id      INTEGER,
                         pipeline_id UUID,
                         status      TEXT NOT NULL
);

-- Stabiles Schema + Suchpfad
CREATE SCHEMA IF NOT EXISTS public;
SET search_path TO public;

-- Kern: Prompts
CREATE TABLE IF NOT EXISTS prompts (
                                       id          SERIAL PRIMARY KEY,
                                       text        TEXT NOT NULL,
                                       prompt_type TEXT NOT NULL CHECK (
                                       prompt_type IN ('ExtractionPrompt','ScoringPrompt','DecisionPrompt','FinalPrompt','MetaPrompt')
    ),
    weight      NUMERIC(6,3),
    json_key    TEXT,
    favorite    BOOLEAN NOT NULL DEFAULT FALSE,

    -- Nur Scoring/Decision dürfen weight haben
    CONSTRAINT weight_only_for_weighted CHECK (
    (prompt_type IN ('ScoringPrompt','DecisionPrompt') AND weight IS NOT NULL)
    OR
(prompt_type NOT IN ('ScoringPrompt','DecisionPrompt') AND weight IS NULL)
    )
    );

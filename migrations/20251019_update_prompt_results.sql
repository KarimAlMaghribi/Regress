DO
$$
BEGIN
  IF
to_regclass('public.prompt_results') IS NULL THEN
CREATE TABLE public.prompt_results
(
    id          BIGSERIAL PRIMARY KEY,
    run_id      UUID REFERENCES pipeline_runs (id) ON DELETE CASCADE,
    prompt_id   INT,
    prompt_type TEXT,
    result      JSONB,
    openai_raw  TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);
END IF;

ALTER TABLE public.prompt_results
    ADD COLUMN IF NOT EXISTS error TEXT,
    ADD COLUMN IF NOT EXISTS source JSONB,
    ADD COLUMN IF NOT EXISTS json_key TEXT;
END $$;

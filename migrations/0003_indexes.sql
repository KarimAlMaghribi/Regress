SET search_path TO public;

-- PDFs/Texte
CREATE INDEX IF NOT EXISTS idx_pdf_texts_pdf_page
    ON pdf_texts(merged_pdf_id, page_no);

-- Runs
CREATE INDEX IF NOT EXISTS idx_runs_pipeline_created
    ON pipeline_runs(pipeline_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_pdf
    ON pipeline_runs(pdf_id);

-- Run-Steps/Attempts
CREATE INDEX IF NOT EXISTS idx_prs_run
    ON pipeline_run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_prs_status
    ON pipeline_run_steps(status);
CREATE INDEX IF NOT EXISTS idx_psa_runstep_conf
    ON pipeline_step_attempts(run_step_id, candidate_confidence DESC, id ASC);

-- Runner-spezifische Lookups
CREATE INDEX IF NOT EXISTS idx_prs_run_final_type
    ON pipeline_run_steps (run_id, is_final, prompt_type);
CREATE INDEX IF NOT EXISTS idx_prs_run_final_key
    ON pipeline_run_steps (run_id, final_key) WHERE is_final = TRUE;

-- Eindeutigkeit der Reihenfolge je Run
CREATE UNIQUE INDEX IF NOT EXISTS uq_prs_run_seq
    ON pipeline_run_steps(run_id, seq_no);

-- History
CREATE INDEX IF NOT EXISTS idx_hist_run_time
    ON analysis_history(run_id, event_time);

-- JSONB GIN für Summaries
CREATE INDEX IF NOT EXISTS gin_runs_final_extraction
    ON pipeline_runs USING GIN (final_extraction);
CREATE INDEX IF NOT EXISTS gin_runs_final_scores
    ON pipeline_runs USING GIN (final_scores);
CREATE INDEX IF NOT EXISTS gin_runs_final_decisions
    ON pipeline_runs USING GIN (final_decisions);

-- Prompts/Groups
CREATE INDEX IF NOT EXISTS idx_prompts_type
    ON prompts(prompt_type);
CREATE INDEX IF NOT EXISTS idx_group_prompts_group
    ON group_prompts(group_id);
CREATE INDEX IF NOT EXISTS idx_group_prompts_prompt
    ON group_prompts(prompt_id);

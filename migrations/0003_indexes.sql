SET search_path TO public;

-- PDFs/Texte
CREATE INDEX idx_pdf_texts_pdf_page     ON pdf_texts(merged_pdf_id, page_no);

-- Runs
CREATE INDEX idx_runs_pipeline_created  ON pipeline_runs(pipeline_id, created_at DESC);
CREATE INDEX idx_runs_pdf               ON pipeline_runs(pdf_id);

-- Run-Steps/Attempts
CREATE INDEX idx_prs_run                ON pipeline_run_steps(run_id);
CREATE INDEX idx_prs_status             ON pipeline_run_steps(status);
CREATE INDEX idx_psa_runstep_conf       ON pipeline_step_attempts(run_step_id, candidate_confidence DESC, id ASC);

-- History
CREATE INDEX idx_hist_run_time          ON analysis_history(run_id, event_time);

-- Genau 1 finales Ergebnis pro Step-Instanz
CREATE UNIQUE INDEX uq_psa_final_per_runstep
    ON pipeline_step_attempts(run_step_id)
    WHERE is_final;

-- JSONB GIN für Summaries
CREATE INDEX gin_runs_final_extraction  ON pipeline_runs USING GIN (final_extraction);
CREATE INDEX gin_runs_final_scores      ON pipeline_runs USING GIN (final_scores);
CREATE INDEX gin_runs_final_decisions   ON pipeline_runs USING GIN (final_decisions);

-- Prompts/Groups
CREATE INDEX idx_prompts_type           ON prompts(prompt_type);
CREATE INDEX idx_group_prompts_group    ON group_prompts(group_id);
CREATE INDEX idx_group_prompts_prompt   ON group_prompts(prompt_id);

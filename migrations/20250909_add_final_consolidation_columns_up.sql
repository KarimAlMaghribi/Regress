-- Konsolidierte Ergebnisse und Review-Flag auf pipeline_runs ablegen
ALTER TABLE pipeline_runs
    ADD COLUMN IF NOT EXISTS final_scores      JSONB,
    ADD COLUMN IF NOT EXISTS final_decisions   JSONB,
    ADD COLUMN IF NOT EXISTS review_required   BOOLEAN NOT NULL DEFAULT FALSE;

-- (Optional) Indizes für schnellere Abfragen
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_extracted_gin
    ON pipeline_runs USING GIN (extracted);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_final_scores_gin
    ON pipeline_runs USING GIN (final_scores);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_final_decisions_gin
    ON pipeline_runs USING GIN (final_decisions);

-- (Optional) schnelles Lookup des letzten Runs pro (pipeline_id, pdf_id)
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline_pdf
    ON pipeline_runs (pipeline_id, pdf_id);

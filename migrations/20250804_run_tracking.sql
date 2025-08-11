CREATE TABLE pipeline_runs (
  id UUID PRIMARY KEY, pipeline_id UUID NOT NULL, pdf_id INT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ,
  overall_score REAL, extracted JSONB
);
CREATE TABLE pipeline_run_steps (
  run_id UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  seq_no INT, step_id TEXT, prompt_id INT, prompt_type TEXT,
  decision_key TEXT, route TEXT, result JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (run_id, seq_no)
);

SET search_path TO public;

CREATE TABLE IF NOT EXISTS sharepoint_jobs (
    id UUID PRIMARY KEY,
    folder_id TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','paused','succeeded','failed','canceled')),
    progress DOUBLE PRECISION NOT NULL DEFAULT 0,
    message TEXT,
    order_key TEXT NOT NULL,
    filenames_override TEXT[],
    upload_url TEXT,
    tenant_id UUID,
    pipeline_id UUID,
    pipeline_run_id UUID REFERENCES pipeline_runs(id) ON DELETE SET NULL,
    upload_id INTEGER,
    pdf_id INTEGER,
    output JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sharepoint_jobs_created_at ON sharepoint_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sharepoint_jobs_status ON sharepoint_jobs (status);
CREATE INDEX IF NOT EXISTS idx_sharepoint_jobs_pdf_id ON sharepoint_jobs (pdf_id);
CREATE INDEX IF NOT EXISTS idx_sharepoint_jobs_upload_id ON sharepoint_jobs (upload_id);

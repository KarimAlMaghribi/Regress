BEGIN;

CREATE TABLE IF NOT EXISTS analysis_history (
                                                id          SERIAL PRIMARY KEY,
                                                pdf_id      INTEGER                  NOT NULL,
                                                pipeline_id UUID                     NOT NULL,
                                                state       JSONB,
                                                pdf_url     TEXT,
                                                "timestamp" TIMESTAMPTZ,
                                                status      TEXT                     NOT NULL DEFAULT 'running',
                                                score       DOUBLE PRECISION,
                                                label       TEXT
);

CREATE INDEX IF NOT EXISTS idx_ah_pdf_id_timestamp_desc
    ON analysis_history (pdf_id, "timestamp" DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='uploads' AND column_name='pipeline_id'
  ) THEN
ALTER TABLE uploads ADD COLUMN pipeline_id UUID;
END IF;
END $$;

COMMIT;

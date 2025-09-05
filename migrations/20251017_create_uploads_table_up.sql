DO
$$
BEGIN
CREATE TABLE IF NOT EXISTS uploads
(
    id
    SERIAL
    PRIMARY
    KEY,
    pdf_id
    INTEGER,
    pipeline_id
    UUID,
    status
    TEXT
    NOT
    NULL
    DEFAULT
    'running'
);

IF
NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='uploads' AND column_name='pipeline_id'
  ) THEN
ALTER TABLE uploads
    ADD COLUMN pipeline_id UUID;
END IF;

  IF
NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='uploads' AND column_name='status'
  ) THEN
ALTER TABLE uploads
    ADD COLUMN status TEXT;
END IF;

ALTER TABLE uploads
    ALTER COLUMN status SET DEFAULT 'running';
UPDATE uploads
SET status = 'running'
WHERE status IS NULL;
ALTER TABLE uploads
    ALTER COLUMN status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_uploads_pdf_id ON uploads(pdf_id);
END $$;

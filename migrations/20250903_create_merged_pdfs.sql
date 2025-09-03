BEGIN;

CREATE TABLE IF NOT EXISTS merged_pdfs (
                                           id         SERIAL PRIMARY KEY,
                                           sha256     TEXT    NOT NULL,
                                           size_bytes INTEGER NOT NULL,
                                           data       BYTEA   NOT NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'pdf_sources'
  ) THEN
ALTER TABLE pdf_sources
DROP CONSTRAINT IF EXISTS pdf_sources_pdf_id_fkey;

ALTER TABLE pdf_sources
    ADD CONSTRAINT pdf_sources_pdf_id_fkey
        FOREIGN KEY (pdf_id) REFERENCES merged_pdfs(id)
            ON DELETE CASCADE;
END IF;
END $$;

COMMIT;

BEGIN;
ALTER TABLE IF EXISTS pdf_sources
DROP CONSTRAINT IF EXISTS pdf_sources_pdf_id_fkey;
DROP TABLE IF EXISTS merged_pdfs;
COMMIT;

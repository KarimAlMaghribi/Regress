BEGIN;

DO
$$
BEGIN
  IF
NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pdf_texts' AND column_name='merged_pdf_id'
  ) THEN
ALTER TABLE pdf_texts
    ADD COLUMN merged_pdf_id INTEGER;
END IF;

  IF
NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pdf_texts' AND column_name='page_no'
  ) THEN
ALTER TABLE pdf_texts
    ADD COLUMN page_no INTEGER;
END IF;
END $$;

DO
$$
BEGIN
  IF
EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pdf_texts' AND column_name='pdf_id'
  ) THEN
UPDATE pdf_texts
SET merged_pdf_id = COALESCE(merged_pdf_id, pdf_id),
    page_no       = COALESCE(page_no, 0)
WHERE merged_pdf_id IS NULL
   OR page_no IS NULL;
ELSE
UPDATE pdf_texts
SET page_no = COALESCE(page_no, 0)
WHERE page_no IS NULL;
END IF;
END $$;

DO
$$
DECLARE
pk_name text;
BEGIN
SELECT conname
INTO pk_name
FROM pg_constraint
WHERE conrelid = 'pdf_texts'::regclass
     AND contype  = 'p'
   LIMIT 1;

IF
pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE pdf_texts DROP CONSTRAINT %I', pk_name);
END IF;

  IF
NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'pdf_texts'::regclass
       AND conname  = 'pdf_texts_merged_pdf_id_page_no_key'
  ) THEN
ALTER TABLE pdf_texts
    ADD CONSTRAINT pdf_texts_merged_pdf_id_page_no_key
        UNIQUE (merged_pdf_id, page_no);
END IF;

ALTER TABLE pdf_texts
    ALTER COLUMN merged_pdf_id SET NOT NULL,
ALTER
COLUMN page_no       SET NOT NULL;

  IF
NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pdf_texts' AND column_name='text'
  ) THEN
ALTER TABLE pdf_texts
    ADD COLUMN text TEXT;
END IF;

ALTER TABLE pdf_texts
    ALTER COLUMN text SET NOT NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_pdf_texts_merged_pdf_id
    ON pdf_texts (merged_pdf_id);

ALTER TABLE pdf_texts
DROP
CONSTRAINT IF EXISTS pdf_texts_merged_pdf_id_fkey,
  ADD  CONSTRAINT pdf_texts_merged_pdf_id_fkey
       FOREIGN KEY (merged_pdf_id) REFERENCES merged_pdfs(id) ON DELETE
CASCADE;

CREATE
OR REPLACE VIEW pdf_texts_flat AS
SELECT merged_pdf_id                            AS pdf_id,
       string_agg(text, E'\n' ORDER BY page_no) AS text
FROM pdf_texts
GROUP BY merged_pdf_id;

COMMIT;

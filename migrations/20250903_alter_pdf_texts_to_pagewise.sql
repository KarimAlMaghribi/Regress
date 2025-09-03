BEGIN;

ALTER TABLE pdf_texts
    RENAME COLUMN pdf_id TO merged_pdf_id;

ALTER TABLE pdf_texts
    ADD COLUMN IF NOT EXISTS page_no INTEGER;
UPDATE pdf_texts SET page_no = 0 WHERE page_no IS NULL;
ALTER TABLE pdf_texts
    ALTER COLUMN page_no SET NOT NULL;

ALTER TABLE pdf_texts DROP CONSTRAINT IF EXISTS pdf_texts_pkey;
ALTER TABLE pdf_texts DROP CONSTRAINT IF EXISTS pdf_texts_pdf_id_key;

ALTER TABLE pdf_texts
    ADD CONSTRAINT pdf_texts_unique UNIQUE (merged_pdf_id, page_no);

COMMIT;

BEGIN;
ALTER TABLE pdf_texts DROP CONSTRAINT IF EXISTS pdf_texts_unique;
ALTER TABLE pdf_texts DROP COLUMN IF EXISTS page_no;
ALTER TABLE pdf_texts RENAME COLUMN merged_pdf_id TO pdf_id;
ALTER TABLE pdf_texts ADD PRIMARY KEY (pdf_id);
COMMIT;

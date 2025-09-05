DO
$$
BEGIN
  IF
EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name='pdf_texts'
  ) THEN
    IF NOT EXISTS (
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

    IF
EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='pdf_texts' AND column_name='pdf_id'
    ) THEN
UPDATE pdf_texts
SET merged_pdf_id = COALESCE(merged_pdf_id, pdf_id),
    page_no       = COALESCE(page_no, 0);
ELSE
UPDATE pdf_texts
SET page_no = COALESCE(page_no, 0);
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

    IF
EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name='pdf_texts' AND column_name='pdf_id'
    ) THEN
ALTER TABLE pdf_texts DROP COLUMN pdf_id;
END IF;

ALTER TABLE pdf_texts
    ALTER COLUMN merged_pdf_id SET NOT NULL,
ALTER
COLUMN page_no       SET NOT NULL,
      ALTER
COLUMN text          SET NOT NULL;
END IF;
END $$;

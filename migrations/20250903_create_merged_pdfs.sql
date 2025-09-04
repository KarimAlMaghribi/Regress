-- 20250903_create_merged_pdfs.sql  (UP only)
BEGIN;

CREATE TABLE IF NOT EXISTS public.merged_pdfs
(
    id
    SERIAL
    PRIMARY
    KEY,
    sha256
    TEXT
    NOT
    NULL,
    size_bytes
    INTEGER
    NOT
    NULL,
    data
    BYTEA
    NOT
    NULL
);

DO
$$
BEGIN
  IF
EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pdf_sources'
  ) THEN
ALTER TABLE public.pdf_sources DROP CONSTRAINT IF EXISTS pdf_sources_pdf_id_fkey;

ALTER TABLE public.pdf_sources
    ADD CONSTRAINT pdf_sources_pdf_id_fkey
        FOREIGN KEY (pdf_id) REFERENCES public.merged_pdfs (id)
            ON DELETE CASCADE NOT VALID;

END IF;
END $$;

COMMIT;

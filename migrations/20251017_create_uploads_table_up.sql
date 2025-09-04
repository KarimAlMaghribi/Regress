BEGIN;

CREATE TYPE public.upload_state AS ENUM ('pending', 'running', 'success', 'failed');

CREATE TABLE public.uploads
(
    id          UUID PRIMARY KEY,
    filename    TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    ocr_status public.upload_state DEFAULT 'pending',
    layout_status public.upload_state DEFAULT 'pending',
    created_at  TIMESTAMPTZ DEFAULT now()
);

COMMIT;

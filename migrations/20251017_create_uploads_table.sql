-- up
CREATE TYPE upload_state AS ENUM ('pending', 'running', 'success', 'failed');

CREATE TABLE uploads (
  id UUID PRIMARY KEY,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  ocr_status upload_state DEFAULT 'pending',
  layout_status upload_state DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- down
DROP TABLE IF EXISTS uploads;
DROP TYPE IF EXISTS upload_state;

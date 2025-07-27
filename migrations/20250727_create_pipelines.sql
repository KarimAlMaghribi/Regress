-- up
CREATE TABLE pipelines (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  config_json JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- down
DROP TABLE IF EXISTS pipelines;

-- up
ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS pipeline_id UUID;

ALTER TABLE IF EXISTS classification_history
  RENAME TO analysis_history;

ALTER TABLE analysis_history
  ADD COLUMN IF NOT EXISTS pipeline_id UUID,
  ADD COLUMN IF NOT EXISTS state JSONB,
  ADD COLUMN IF NOT EXISTS label TEXT,
  ALTER COLUMN status SET DEFAULT 'completed';

-- down
ALTER TABLE uploads DROP COLUMN IF EXISTS pipeline_id;

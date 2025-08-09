-- up
ALTER TABLE jamiah_cycles
  ADD COLUMN IF NOT EXISTS recipient_id UUID;

-- down
ALTER TABLE jamiah_cycles
  DROP COLUMN IF EXISTS recipient_id;

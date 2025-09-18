BEGIN;

ALTER TABLE pipeline_runs
    ADD COLUMN IF NOT EXISTS status TEXT;

-- sinnvolle Default- und Backfill-Logik
UPDATE pipeline_runs
SET status = CASE
                 WHEN status IS NOT NULL THEN status
                 WHEN finished_at IS NULL THEN 'running'
                 ELSE 'finished'
    END
WHERE status IS NULL;

ALTER TABLE pipeline_runs
    ALTER COLUMN status SET DEFAULT 'running';

-- optional, wenn Backfill durch ist:
-- ALTER TABLE pipeline_runs ALTER COLUMN status SET NOT NULL;

-- Index für schnelle Listen
CREATE INDEX IF NOT EXISTS idx_runs_status_started
    ON pipeline_runs (status, started_at DESC);

COMMIT;

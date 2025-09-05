DO $$
BEGIN
CREATE TABLE IF NOT EXISTS pipelines (
                                         id          UUID PRIMARY KEY,
                                         name        TEXT  NOT NULL,
                                         config_json JSONB NOT NULL,
                                         created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
    );

IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipelines' AND column_name='created_at'
  ) THEN
ALTER TABLE pipelines ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='pipelines' AND column_name='updated_at'
  ) THEN
ALTER TABLE pipelines ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
END IF;

ALTER TABLE pipelines ALTER COLUMN name        SET NOT NULL;
ALTER TABLE pipelines ALTER COLUMN config_json SET NOT NULL;
ALTER TABLE pipelines ALTER COLUMN created_at  SET DEFAULT now();
ALTER TABLE pipelines ALTER COLUMN updated_at  SET DEFAULT now();
END $$;


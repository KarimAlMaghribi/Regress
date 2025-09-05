DO
$$
BEGIN
  IF
to_regclass('public.pipelines') IS NULL THEN
CREATE TABLE public.pipelines
(
    id          UUID PRIMARY KEY,
    name        TEXT  NOT NULL,
    config_json JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);
ELSE
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='pipelines' AND column_name='created_at'
    ) THEN
      EXECUTE 'ALTER TABLE public.pipelines ADD COLUMN created_at TIMESTAMPTZ DEFAULT now()';
END IF;

    IF
NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='pipelines' AND column_name='updated_at'
    ) THEN
      EXECUTE 'ALTER TABLE public.pipelines ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now()';
END IF;

BEGIN
EXECUTE 'ALTER TABLE public.pipelines ALTER COLUMN name        SET NOT NULL';
EXCEPTION WHEN others THEN
      RAISE NOTICE 'pipelines.name NOT NULL konnte nicht gesetzt werden (ggf. Alt-NULL-Werte).';
END;

BEGIN
EXECUTE 'ALTER TABLE public.pipelines ALTER COLUMN config_json SET NOT NULL';
EXCEPTION WHEN others THEN
      RAISE NOTICE 'pipelines.config_json NOT NULL konnte nicht gesetzt werden (ggf. Alt-NULL-Werte).';
END;

BEGIN
EXECUTE 'ALTER TABLE public.pipelines ALTER COLUMN created_at  SET DEFAULT now()';
EXCEPTION WHEN others THEN
      RAISE NOTICE 'pipelines.created_at DEFAULT konnte nicht gesetzt werden.';
END;

BEGIN
EXECUTE 'ALTER TABLE public.pipelines ALTER COLUMN updated_at  SET DEFAULT now()';
EXCEPTION WHEN others THEN
      RAISE NOTICE 'pipelines.updated_at DEFAULT konnte nicht gesetzt werden.';
END;
END IF;
END $$;

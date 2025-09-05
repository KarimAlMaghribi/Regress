DO $$
BEGIN
  IF to_regclass('public.pipelines') IS NOT NULL THEN
DROP TABLE public.pipelines;
END IF;
END $$;

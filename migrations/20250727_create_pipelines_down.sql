DO
$$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='pipelines') THEN
DROP TABLE pipelines;
END IF;
END $$;
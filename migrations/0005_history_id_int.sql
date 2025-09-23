-- migrations/0005_history_id_int.sql
SET search_path TO public;

-- Primärschlüssel von BIGINT -> INT (SERVICE erwartet i32)
-- Voraussetzung: es gibt (noch) keine Fremdschlüssel auf analysis_history(id)
-- und die bestehenden IDs liegen im int4-Bereich (neu aufgesetzte DB: unkritisch).
ALTER TABLE analysis_history
ALTER COLUMN id TYPE INT USING id::INT;

-- Sicherstellen, dass die Sequenz weiterhin als Default hinterlegt ist
DO $$
DECLARE seq_name text;
BEGIN
SELECT pg_get_serial_sequence('analysis_history','id') INTO seq_name;
IF seq_name IS NOT NULL THEN
    -- Ownership & Default sauber setzen (idempotent)
    EXECUTE format('ALTER SEQUENCE %s OWNED BY analysis_history.id', seq_name);
EXECUTE format('ALTER TABLE analysis_history ALTER COLUMN id SET DEFAULT nextval(%L)', seq_name);
END IF;
END$$;

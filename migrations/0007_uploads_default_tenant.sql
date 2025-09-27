-- 0007_uploads_default_tenant.sql
-- Fängt Inserts ohne tenant_id auf und setzt "Default".
-- Nimmt KEINE fachliche Zuordnung vor; nur Stabilisierung!

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE name = 'Default') THEN
    INSERT INTO tenants(name) VALUES ('Default');
END IF;
END$$;

CREATE OR REPLACE FUNCTION trg_uploads_default_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := (SELECT id FROM tenants WHERE name = 'Default');
END IF;
RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS uploads_default_tenant ON uploads;
CREATE TRIGGER uploads_default_tenant
    BEFORE INSERT ON uploads
    FOR EACH ROW
    EXECUTE FUNCTION trg_uploads_default_tenant();

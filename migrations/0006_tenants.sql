-- migrations/0006_tenants.sql
SET search_path TO public;

-- 1) Basis: Tenants-Tabelle (UUID + Name)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
                                       id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

-- 2) uploads um tenant_id erweitern
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- 2a) Default-Tenant anlegen & bestehende uploads mappen
DO $$
DECLARE v_id UUID;
BEGIN
INSERT INTO tenants(name) VALUES ('Default')
    ON CONFLICT (name) DO NOTHING;

SELECT id INTO v_id FROM tenants WHERE name = 'Default';

UPDATE uploads
SET tenant_id = COALESCE(tenant_id, v_id)
WHERE tenant_id IS NULL;
END$$;

-- 2b) FK + NOT NULL scharf schalten
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'uploads' AND constraint_name = 'uploads_tenant_id_fkey'
  ) THEN
ALTER TABLE uploads
    ADD CONSTRAINT uploads_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
END IF;
END$$;

ALTER TABLE uploads ALTER COLUMN tenant_id SET NOT NULL;

-- 3) Indizes
CREATE INDEX IF NOT EXISTS idx_uploads_tenant       ON uploads(tenant_id, id);
CREATE INDEX IF NOT EXISTS idx_uploads_pdf_pipe_tnt ON uploads(pdf_id, pipeline_id, tenant_id);

-- 4) Views für Abfragen mit Tenant-Name (für /analyses, /history)
--    Zuordnung per "jüngstem" Upload (höchste uploads.id) je (pdf_id, pipeline_id)
CREATE OR REPLACE VIEW v_pipeline_runs_with_tenant AS
SELECT
    pr.*,
    t.id   AS tenant_id,
    t.name AS tenant_name
FROM pipeline_runs pr
         LEFT JOIN LATERAL (
    SELECT u.*
    FROM uploads u
    WHERE u.pdf_id = pr.pdf_id
      AND (u.pipeline_id IS NULL OR u.pipeline_id = pr.pipeline_id)
    ORDER BY u.id DESC
        LIMIT 1
) u ON TRUE
    LEFT JOIN tenants t ON t.id = u.tenant_id;

CREATE OR REPLACE VIEW v_analysis_history_with_tenant AS
SELECT
    ah.*,
    t.id   AS tenant_id,
    t.name AS tenant_name
FROM analysis_history ah
         LEFT JOIN LATERAL (
    SELECT u.*
    FROM uploads u
    WHERE u.pdf_id = ah.pdf_id
      AND (ah.pipeline_id IS NULL OR u.pipeline_id = ah.pipeline_id)
    ORDER BY u.id DESC
        LIMIT 1
) u ON TRUE
    LEFT JOIN tenants t ON t.id = u.tenant_id;

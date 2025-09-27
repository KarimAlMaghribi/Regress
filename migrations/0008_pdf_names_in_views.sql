-- migrations/0007_pdf_names_in_views.sql
SET search_path TO public;

-- v_pipeline_runs_with_tenant um pdf_names erweitern
CREATE OR REPLACE VIEW v_pipeline_runs_with_tenant AS
SELECT
    pr.*,
    t.id   AS tenant_id,
    t.name AS tenant_name,
    ps.names AS pdf_names
FROM pipeline_runs pr
         LEFT JOIN LATERAL (
    SELECT u.*
    FROM uploads u
    WHERE u.pdf_id = pr.pdf_id
      AND (u.pipeline_id IS NULL OR u.pipeline_id = pr.pipeline_id)
    ORDER BY u.id DESC
        LIMIT 1
) u ON TRUE
    LEFT JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN pdf_sources ps ON ps.pdf_id = pr.pdf_id;

-- v_analysis_history_with_tenant um pdf_names erweitern
CREATE OR REPLACE VIEW v_analysis_history_with_tenant AS
SELECT
    ah.*,
    t.id   AS tenant_id,
    t.name AS tenant_name,
    ps.names AS pdf_names
FROM analysis_history ah
         LEFT JOIN LATERAL (
    SELECT u.*
    FROM uploads u
    WHERE u.pdf_id = ah.pdf_id
      AND (ah.pipeline_id IS NULL OR u.pipeline_id = ah.pipeline_id)
    ORDER BY u.id DESC
        LIMIT 1
) u ON TRUE
    LEFT JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN pdf_sources ps ON ps.pdf_id = ah.pdf_id;

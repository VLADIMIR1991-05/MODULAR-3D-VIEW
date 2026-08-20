-- VALIDAR INGENIERIA queda fuera del catálogo comercial.
-- Se conserva la fila y cualquier licencia histórica para no perder información.
UPDATE platform_products
SET active=0, updated_at=CURRENT_TIMESTAMP
WHERE code='validar_ingenieria';


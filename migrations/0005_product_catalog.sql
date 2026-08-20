-- Catálogo extensible para aplicaciones web y plugins.
ALTER TABLE platform_products ADD COLUMN product_type TEXT NOT NULL DEFAULT 'web';
ALTER TABLE platform_products ADD COLUMN launch_url TEXT;
ALTER TABLE platform_products ADD COLUMN download_url TEXT;
ALTER TABLE platform_products ADD COLUMN repository_url TEXT;
ALTER TABLE platform_products ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 100;

UPDATE platform_products SET
  product_type='plugin',
  repository_url='https://github.com/VLADIMIR1991-05/MODULAR-3D-VIEW',
  sort_order=10
WHERE code='modular3d_plugin';

UPDATE platform_products SET
  product_type='web',
  launch_url='https://modular-3d-view.lenin19910527.workers.dev',
  repository_url='https://github.com/VLADIMIR1991-05/MODULAR-3D-VIEW',
  sort_order=20
WHERE code='modular3d_view';

UPDATE platform_products SET
  product_type='web',
  launch_url='https://qr-dinamico.lenin19910527.workers.dev',
  sort_order=30
WHERE code='qr_dinamico';

CREATE INDEX IF NOT EXISTS idx_platform_products_catalog
  ON platform_products(active,product_type,sort_order);

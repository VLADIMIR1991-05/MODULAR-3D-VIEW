# MODULAR-3D VIEW

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/VLADIMIR1991-05/MODULAR-3D-VIEW)

Aplicación web independiente para validar licencias de MODULAR-3D VIEW y visualizar modelos 3D optimizados sin depender de una API pagada de Trimble Connect.

## Flujo

1. Validación de correo y licencia.
2. Selección local de un modelo GLB/GLTF.
3. Visualización con materiales, órbita, zoom y encuadre automático.
4. Próxima integración: publicación desde SketchUp y almacenamiento R2 por licencia.

## Desarrollo local

```bash
cp .env.example .env
npm install
npm start
```

Node no carga `.env` automáticamente. Para una prueba local rápida:

```bash
ALLOW_DEMO_LICENSE=true DEMO_LICENSE_KEY=M3D-VIEW-2026-DEMO APP_BASE_URL=http://localhost:3000 npm start
```

## Variables privadas

- `LICENSE_SERVER_URL`: endpoint del servidor de licencias Modular-3D.
- `LICENSE_SERVER_TOKEN`: token opcional del servidor de licencias.
- `TRIMBLE_CLIENT_ID`: Consumer Key entregada por Trimble.
- `TRIMBLE_CLIENT_SECRET`: Consumer Secret; nunca se publica.
- `TRIMBLE_APP_NAME`: nombre/scope registrado por Trimble.
- `TRIMBLE_CALLBACK_URL`: URL exacta registrada, por ejemplo `https://dominio/api/trimble/callback`.
- `TRIMBLE_REGION`: `us`, `eu` o `asia`.

El despliegue principal utiliza `MODULAR_3D_SESSIONS` con el binding `SESSIONS`. Esto mantiene licencias, estados OAuth y tokens disponibles entre distintas instancias del Worker.

## Cloudflare

```bash
npm install
npx wrangler secret put TRIMBLE_CLIENT_ID
npx wrangler secret put TRIMBLE_CLIENT_SECRET
npx wrangler secret put TRIMBLE_APP_NAME
npx wrangler secret put TRIMBLE_CALLBACK_URL
npx wrangler deploy
```

La instancia principal está publicada en `https://modular-3d-view.lenin19910527.workers.dev`. Para desplegar una copia en otra cuenta se debe crear su propio KV y reemplazar el `id` de `kv_namespaces`.

## Render

El archivo `render.yaml` permite crear el servicio desde un Blueprint. Configura las variables marcadas como `sync: false` en el panel de Render.

## Estado del visor

El visor propio usa Three.js y carga GLB/GLTF directamente en el navegador. Los modelos locales no se suben al servidor en esta primera fase. La publicación mediante enlaces y QR utilizará un bucket R2 con acceso controlado por la sesión de licencia.

# MODURAL-3D VIEW

Aplicación web para validar licencias de MODURAL-3D VIEW y conectar cada usuario con sus proyectos de SketchUp almacenados en Trimble Connect.

## Flujo

1. Validación de correo y licencia.
2. Inicio de sesión seguro mediante Trimble ID.
3. Consulta de proyectos permitidos en Trimble Connect.
4. Apertura del proyecto en el visor 3D oficial mediante Workspace API.

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

- `SESSION_SECRET`: valor aleatorio largo.
- `LICENSE_SERVER_URL`: endpoint del servidor de licencias Modular-3D.
- `LICENSE_SERVER_TOKEN`: token opcional del servidor de licencias.
- `TRIMBLE_CLIENT_ID`: Consumer Key entregada por Trimble.
- `TRIMBLE_CLIENT_SECRET`: Consumer Secret; nunca se publica.
- `TRIMBLE_APP_NAME`: nombre/scope registrado por Trimble.
- `TRIMBLE_CALLBACK_URL`: URL exacta registrada, por ejemplo `https://dominio/api/trimble/callback`.
- `TRIMBLE_REGION`: `us`, `eu` o `asia`.

## Cloudflare

```bash
npm install
npx wrangler secret put TRIMBLE_CLIENT_ID
npx wrangler secret put TRIMBLE_CLIENT_SECRET
npx wrangler secret put TRIMBLE_APP_NAME
npx wrangler secret put TRIMBLE_CALLBACK_URL
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

Para producción se recomienda sustituir los mapas de sesión en memoria por Workers KV o D1.

## Render

El archivo `render.yaml` permite crear el servicio desde un Blueprint. Configura las variables marcadas como `sync: false` en el panel de Render.

## Estado del visor

El visor oficial está integrado mediante Workspace API (`embed.setTokens` y `embed.init3DViewer`). Trimble debe tener registrado y habilitado el dominio final y la URL de retorno para que el componente pueda cargar proyectos reales.

Los tokens de actualización permanecen en el servidor. El navegador recibe solamente el token de acceso temporal requerido por el componente oficial.

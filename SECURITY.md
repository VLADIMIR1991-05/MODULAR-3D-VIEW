# Seguridad

## Credenciales

Nunca publiques `TRIMBLE_CLIENT_SECRET`, tokens de licencia, claves de sesión ni credenciales de Cloudflare. Utiliza secretos del proveedor de alojamiento.

## Sesiones

En Cloudflare debe configurarse Workers KV con el binding `SESSIONS`. En Render, para una primera versión se usa memoria del proceso; para varias instancias debe conectarse un almacén compartido.

## Reportes

Los problemas de seguridad deben reportarse de forma privada al propietario del repositorio y no mediante issues públicos.

# Tably

Aplicación para cafés con menú por mesa, pedidos persistidos, panel del local y códigos QR descargables.

## Requisitos

- Node.js 22 o superior y npm.
- PostgreSQL 15 o superior.
- Docker Desktop para ejecutar PostgreSQL local con el `docker-compose.yml` incluido, o una instancia PostgreSQL accesible.

## Desarrollo local

1. Copia `.env.example` a `.env` y completa `DATABASE_URL` y `JWT_SECRET`.
2. Inicia la base local con `docker compose up -d db`, o configura una base PostgreSQL en `DATABASE_URL`.
3. Ejecuta `npm install`, `npm run db:setup` y `npm run dev`.
4. Abre `http://localhost:3001`.

Genera un `JWT_SECRET` de al menos 32 caracteres. No subas `.env` ni pegues credenciales en el chat. Las credenciales `tably/tably` de Docker Compose son únicamente para desarrollo local.

## Cobros de pedidos

El cliente elige entre efectivo y Mercado Pago o tarjeta. En ambas opciones, la app avisa al personal para que cobre en la mesa. El pedido no pasa a cocina hasta que el personal confirma el cobro desde el panel del café. Tably no procesa pagos online en esta versión.

## Suscripciones de cafés

La suscripción no se cobra automáticamente. Cada cuenta tiene un período de prueba de 30 días y el panel del café muestra su vencimiento. El acceso `/platform-admin` permite a Tably revisar los estados y vencimientos, registrar pagos y ajustar fechas. Los avisos se ven al entrar al panel; no se envían emails.

Desde `/platform-admin`, Tably también puede deshabilitar o rehabilitar una cuenta. Al deshabilitarla se revocan las sesiones de gestión, se bloquean las modificaciones y el acceso de sus QR muestra un aviso de servicio no disponible. Esta acción es independiente del estado de suscripción.

Configura `PLATFORM_ADMIN_EMAIL` y `PLATFORM_ADMIN_PASSWORD` como variables privadas del servidor para habilitar ese acceso. Usa una contraseña larga y única.

## Despliegue

`render.yaml` configura un servicio web y una base PostgreSQL con planes pagos. Para el plan gratuito de Netlify, el proyecto usa una función para la API y publica `web/` como sitio estático. En las variables del sitio de Netlify, configura `DATABASE_URL` (una base PostgreSQL accesible desde Netlify), `JWT_SECRET` (al menos 32 caracteres), `PLATFORM_ADMIN_EMAIL` y `PLATFORM_ADMIN_PASSWORD`; asegúrate de que estén disponibles para Functions. Netlify proporciona la URL pública como `URL`; la función la usa para construir enlaces y validar el origen. La base de datos se inicializa al recibir la primera solicitud.

## Pruebas

`npm test` ejecuta pruebas automatizadas aisladas. El smoke test de PostgreSQL se ejecuta por separado con `npm run smoke` y requiere `TABLY_TEST_DATABASE_URL` apuntando a una base de pruebas con un host distinto de `DATABASE_URL`; crea una cuenta temporal y la elimina al finalizar.

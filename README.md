# Tably

Aplicación para cafés con menú por mesa, pedidos persistidos, panel del local y códigos QR descargables.

## Requisitos

- Node.js 20 o superior y npm.
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

Configura `PLATFORM_ADMIN_EMAIL` y `PLATFORM_ADMIN_PASSWORD` como variables privadas del servidor para habilitar ese acceso. Usa una contraseña larga y única.

## Despliegue

`render.yaml` configura un servicio web y una base PostgreSQL con planes pagos. Para el plan gratuito de Netlify, el proyecto usa una función para la API y publica `web/` como sitio estático. Configura `DATABASE_URL` (PostgreSQL), `JWT_SECRET`, `PLATFORM_ADMIN_EMAIL` y `PLATFORM_ADMIN_PASSWORD` en las variables privadas del sitio. Netlify proporciona la URL pública como `URL`; la función la usa para construir enlaces y validar el origen. La base de datos se inicializa al recibir la primera solicitud.

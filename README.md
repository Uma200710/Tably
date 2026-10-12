# Tably

Aplicación separada del demo original. Incluye menús por mesa, pedidos persistidos, panel del local, QR descargables y puntos de integración para Mercado Pago.

## Requisitos

- Node.js 20 o superior y npm.
- PostgreSQL 15 o superior.
- Docker Desktop para ejecutar PostgreSQL local con el `docker-compose.yml` incluido, o una instancia PostgreSQL accesible.
- Una URL pública HTTPS para los QR, las URLs de retorno y los webhooks de Mercado Pago.
- Una aplicación de Mercado Pago Developers para Argentina.

## Desarrollo local

1. Copia `.env.example` a `.env` y completa `DATABASE_URL`, `JWT_SECRET` y `TOKEN_ENCRYPTION_KEY_BASE64`.
2. Inicia la base local con `docker compose up -d db`, o configura una base PostgreSQL administrada en `DATABASE_URL`.
3. Ejecuta `npm install`, `npm run db:setup` y `npm run dev`.
4. Abre `http://localhost:3001`. El puerto 3000 queda libre para una instalación local de PostgreSQL.

Genera los secretos localmente, por ejemplo con `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` para la clave de cifrado. No subas `.env` ni pegues credenciales en el chat. Las credenciales `tably/tably` de Docker Compose son únicamente para desarrollo local.

## Mercado Pago

- La aplicación de Mercado Pago debe pertenecer a la cuenta propietaria de Tably. Configura `MP_CLIENT_ID`, `MP_CLIENT_SECRET` y `MP_WEBHOOK_SECRET` en el entorno privado del servidor.
- Al registrarse, cada café autoriza a Tably en Mercado Pago mediante OAuth. No se solicitan ni guardan contraseñas o access tokens ingresados por el café; los tokens OAuth recibidos se cifran en la base.
- Cada pedido crea una preferencia Checkout Pro con el access token OAuth del café, por lo que el pago se acredita a ese café.
- Las suscripciones se crean con un token `client_credentials` de la aplicación propiedad de Tably y el recurso `preapproval`; los cobros se acreditan a la cuenta dueña de esa aplicación.
- El pago del cliente no se confirma al volver desde Checkout Pro. Solo se libera a cocina después de consultar el pago en Mercado Pago, comprobar vendedor, importe y moneda, y validar la firma del webhook.
- Registra como redirect URI exacta `${PUBLIC_URL}/api/mercadopago/callback` en la aplicación. Configura `https://${tu-dominio}/api/payments/webhook` como URL de notificación y activa eventos de pagos y suscripciones.
- Para probar OAuth local, `PUBLIC_URL` debe ser una URL HTTPS accesible por Mercado Pago (por ejemplo, un túnel HTTPS); `localhost` no puede recibir el callback externo.

La integración necesita credenciales de prueba y cuentas de prueba para validarse; para cobrar en producción se requieren credenciales productivas, dominio HTTPS y webhooks configurados. No hay modo de pago simulado que marque pedidos como aprobados.

## Publicar en Render

El archivo `render.yaml` crea un servicio web Node y una base PostgreSQL persistente en Ohio. Usa planes pagos (`0.5c-512mb` para la web y `0.1c-256mb` para PostgreSQL); revisa el precio vigente en Render antes de confirmar la creación. Los planes gratuitos no son adecuados para pedidos reales: el servicio web se duerme y la base gratuita expira a los 30 días.

1. Sube el repositorio a GitHub sin incluir `.env`.
2. En Render, crea un **Blueprint** y conecta ese repositorio. Render leerá `render.yaml`, generará `JWT_SECRET` y `TOKEN_ENCRYPTION_KEY_BASE64`, creará PostgreSQL y ejecutará `npm run db:setup` antes del despliegue.
3. La app toma su URL HTTPS pública desde `RENDER_EXTERNAL_URL`; no hace falta escribir `PUBLIC_URL` manualmente para el dominio `onrender.com`.
4. Cuando esté lista la URL, configura en la aplicación de Mercado Pago el redirect `https://<tu-servicio>.onrender.com/api/mercadopago/callback` y el webhook `https://<tu-servicio>.onrender.com/api/payments/webhook`.
5. Agrega `MP_CLIENT_ID`, `MP_CLIENT_SECRET` y `MP_WEBHOOK_SECRET` en **Environment** del servicio de Render. No los pongas en `render.yaml`, GitHub ni en el chat.

Este workspace tiene un remoto GitHub configurado, pero el despliegue no se crea automáticamente desde el código. Hay que conectar el repositorio y aprobar los planes pagos en tu cuenta de Render.
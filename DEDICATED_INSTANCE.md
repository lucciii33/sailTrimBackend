# Instancia dedicada por cliente

Cada cliente tiene su propia copia de Olivia: frontend, backend, base de datos, bucket y secretos.
Ejemplo con Acme: `https://acme.oliviatools.com` y `https://api.acme.oliviatools.com`.

## Pasos

1. Crear un cluster de Mongo y un bucket S3 solo para este cliente.
2. GitHub: se usa la misma GitHub App de siempre, sin tocar su configuración. En el backend principal, añadir el cliente:

   ```
   OLIVIA_INSTANCES={"acme":"https://api.acme.oliviatools.com"}
   ```
3. Si usan Google, añadir `https://acme.oliviatools.com` a los orígenes autorizados.
4. Backend: entorno nuevo con valores únicos para este cliente:

   ```
   OLIVIA_DEDICATED=true
   OLIVIA_INSTANCE_KEY=acme
   FRONTEND_URL=https://acme.oliviatools.com
   MONGO_URL=
   JWT_SECRET_NODE=
   QA_ENC_KEY=
   OLIVIA_ADMIN_KEY=
   AWS_BUCKET_NAME=
   # Los mismos valores que el backend principal:
   GITHUB_APP_ID=
   GITHUB_APP_SLUG=
   GITHUB_PRIVATE_KEY=
   GITHUB_WEBHOOK_SECRET=
   GITHUB_CLIENT_ID=
   GITHUB_CLIENT_SECRET=
   ANTHROPIC_API_KEY=
   BROWSERBASE_API_KEY=
   BROWSERBASE_PROJECT_ID=
   GOOGLE_CLIENT_ID=
   GOOGLE_ALLOWED_HD=acme.com
   ```

5. Frontend: mismo build, con estas variables:

   ```
   OLIVIA_DEDICATED=true
   OLIVIA_API_URL=https://api.acme.oliviatools.com
   OLIVIA_GOOGLE_CLIENT_ID=
   ```

6. Apuntar los dos subdominios a sus entornos, con HTTPS.
7. Crear el primer usuario desde `backend/`, con `MONGO_URL` y `FRONTEND_URL` del cliente:

   ```
   node scripts/provisionInstance.js --company "Acme" --email owner@acme.com
   ```

   Imprime un enlace para crear la contraseña, válido 24 horas. Envíalo solo a esa persona.

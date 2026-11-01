# Deploy

| Pieza | Servicio | Cómo se despliega |
|---|---|---|
| Web | Vercel | `deploy.yml` sube la salida ya compilada |
| API | Render, plan gratuito | `deploy.yml` lo dispara por API, con el commit exacto |
| Base | Neon | `deploy.yml` aplica las migraciones antes de la API |

Cada PR corre `ci.yml`. Cada push a `main` corre CI y, si pasa, migraciones → API → web. Por ese orden, **una migración tiene que ser compatible con la versión anterior de la API**, que sigue activa hasta que termina el deploy.

## Puesta en marcha (una sola vez)

La variable `DEPLOY_ENABLED` mantiene apagado el deploy hasta terminar estos pasos. Ningún valor secreto va al repo.

1. **Neon:** crear el proyecto `pokercontrol` con PostgreSQL 16 en `AWS US East 1`. Si la contraseña anterior sigue vigente, rotarla. Copiar la cadena de conexión **directa** (sin `-pooler`), con `sslmode=require`.
2. **Render:** New → Blueprint, elegir este repo y la rama `main`. Completar:
   - `DATABASE_URL`: la de Neon.
   - `CORS_ORIGIN`: un valor provisorio; se corrige en el paso 4.
   - `GOOGLE_WEB_CLIENT_ID`: el Client ID web.
   - `GOOGLE_ANDROID_CLIENT_ID`: vacío hasta conectar la APK.

   Anotar la URL (`https://….onrender.com`) y el Service ID (`srv-…`). Crear una API key en Account Settings.
3. **Vercel:** en una carpeta vacía, `npx vercel link --yes --project pokercontrol`. Copiar `orgId` y `projectId` de `.vercel\project.json`. Crear un token en Account Settings → Tokens.
4. **Dominio de la web:** con la URL de producción de Vercel (visible en el dashboard del proyecto), corregir `CORS_ORIGIN` en Render, sin `/` final.
5. **Google:** agregar esa misma URL en "Orígenes autorizados de JavaScript" del client web.
6. **GitHub**, en Settings → Environments → `main`:

   | Tipo | Nombre | Valor |
   |---|---|---|
   | Secret | `DATABASE_URL` | Neon |
   | Secret | `RENDER_API_KEY` | Render |
   | Secret | `RENDER_SERVICE_ID` | `srv-…` |
   | Secret | `VERCEL_TOKEN` | Vercel |
   | Secret | `VERCEL_ORG_ID` | `orgId` |
   | Secret | `VERCEL_PROJECT_ID` | `projectId` |
   | Variable | `VITE_API_URL` | URL de Render, sin `/` final |
   | Variable | `VITE_GOOGLE_CLIENT_ID` | Client ID web |

   Además, en Settings → Secrets and variables → Actions → Variables, crear la variable **de repositorio** `DEPLOY_ENABLED` = `true`.

7. **Primer deploy:** Actions → Deploy → Run workflow, sobre `main`.

## Operación

- **Volver atrás:** revertir el commit en `main`. Si incluía una migración, hace falta otra migración que la deshaga, porque las aplicadas no se revierten solas.
- **Plan gratuito de Render:** el servicio se duerme tras unos 15 minutos sin tráfico. La web avisa "despertando el servidor" y espera hasta 90 s.

# PokerControl Web

Migración web de [PokerControl](https://github.com/hfretes88/PokerControl): SPA React y API Fastify sobre PostgreSQL. La API está pensada para que la APK apunte a ella más adelante.

Esta versión incluye las vistas de la APK, sin informes. El deploy se describe en [docs/deploy.md](docs/deploy.md).

## Estructura

| Ruta | Contenido |
|---|---|
| `apps/api` | API Fastify, Drizzle y servicios |
| `apps/web` | SPA React + Vite |
| `packages/core` | Dominio puro: cálculos, deudas, temporadas, estadísticas |
| `packages/contracts` | Esquemas TypeBox: validación, OpenAPI y tipos de cliente |
| `db/migrations` | Migraciones generadas con drizzle-kit |
| `docs` | Diseño, OpenAPI, migración e integración con la APK |

## Puesta en marcha

Requisitos: Node ≥22, pnpm 12 (`npm install -g pnpm@12.16.1`) y PostgreSQL 16. Los comandos son para `cmd` en Windows.

```bat
copy .env.example .env   &:: completar credenciales, JWT_SECRET y Client ID de Google
pnpm install
pnpm db:migrate
pnpm dev                 &:: web en :5173, API en :3000, Swagger en :3000/docs
```

`pnpm e2e` necesita además una vez `pnpm --filter @pokercontrol/web exec playwright install chromium`.

Si PostgreSQL corre en WSL, la distribución tiene que estar iniciada: la API llega a él por `localhost:5432`.

Crear el rol y las bases (una sola vez):

```sql
CREATE ROLE pokercontrol LOGIN CREATEDB PASSWORD '...';
CREATE DATABASE pokercontrol_dev OWNER pokercontrol;
CREATE DATABASE pokercontrol_test OWNER pokercontrol;
```

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm check` | Typecheck, lint, tests y verificación de `docs/openapi.yaml` |
| `pnpm test` | Tests de core e integración de la API (usa `TEST_DATABASE_URL`, que se vacía) |
| `pnpm e2e` | Playwright en desktop y móvil, con Google reemplazado por un verificador de test |
| `pnpm openapi` | Regenera `docs/openapi.yaml` |
| `pnpm db:generate` | Genera una migración tras cambiar `apps/api/src/db/schema.ts` |

## Auth

1. El cliente obtiene un `idToken` de Google y lo envía a `POST /api/v1/auth/google`.
2. La API lo valida contra `GOOGLE_WEB_CLIENT_ID` y `GOOGLE_ANDROID_CLIENT_ID`, exige `email_verified` y emite su propio JWT HS256 de 30 días.
3. El JWT viaja como `Authorization: Bearer <token>`. `POST /api/v1/auth/refresh` lo renueva.

El flujo no usa el `client_secret`: no lo copies al repo.

## URL base

| Ambiente | URL |
|---|---|
| Local | `http://localhost:3000/api/v1` |
| Producción | La del servicio de Render (ver [docs/deploy.md](docs/deploy.md)) |

## Changelog de la API

- **v1 (sin publicar):** versión inicial, sin informes de reportes.

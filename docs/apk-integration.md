# Integrar la APK con la API

Contrato completo: [`openapi.yaml`](./openapi.yaml), o Swagger en `/docs`. Base: `/api/v1`. Se puede generar un cliente desde el YAML.

## Auth

1. Crear un OAuth Client ID Android en el proyecto de Google Cloud, con el package name y el SHA-1 del keystore (release y debug).
2. Configurarlo en la API con `GOOGLE_ANDROID_CLIENT_ID`.
3. En la APK, `@react-native-google-signin/google-signin` con `webClientId` igual al Client ID Web, para obtener un `idToken`.
4. `POST /auth/google` con `{ idToken }` devuelve `{ token, user, groups }`.
5. Enviar `Authorization: Bearer <token>`. El JWT dura 30 días; `POST /auth/refresh` lo renueva. Guardarlo en almacenamiento seguro.
6. Si `groups` está vacío, ofrecer `POST /groups/join`, y también `POST /groups` si el rol lo permite.
7. Si el rol es `reader` y el grupo activo trae `playerId: null`, pedir el nick antes de mostrar datos: `GET /groups/:groupId/players` lista los jugadores (`linked: false` son los libres) y `POST /groups/:groupId/me/player` recibe `{ playerId }` o `{ name }`.

## Roles

`user.role` viene en `/auth/google` y `/me`, y se valida en cada request.

| Rol | Permisos |
|---|---|
| `master` | Los de admin, más `/admin/users` y `/admin/admins`. Es el primer usuario que ingresó |
| `admin` | Ve todos los grupos y modifica datos, aunque no sea miembro |
| `reader` | Solo lee los grupos donde es miembro. Solo escribe al unirse, abandonar y elegir su jugador |

Una escritura sin permiso responde 403 `read_only`. A `reader`, `Group.inviteCode` le llega `null` y `members[].email` no le llega.

## Convenciones

- **Grupo:** los recursos de dominio cuelgan de `/groups/:groupId`. Un usuario puede tener varios grupos.
- **Errores:** `{ "error": "codigo_snake_case", "message": "Texto para la UI", ... }`.
  - `400` validación, `401` sesión, `403` no es miembro, `404` no existe en ese grupo.
  - `409` conflicto de estado, `422` regla de negocio, `429` demasiados intentos.
- **Montos:** números JSON con hasta 2 decimales.
- **Fechas:** ISO 8601 en UTC. `groups.timezone` indica la zona para mostrarlas.

## Idempotencia

Estas rutas exigen el header `Idempotency-Key` (8 a 128 caracteres; un UUID por operación):

- `POST /seasons/:seasonId/sessions`
- `POST /sessions/:id/buys`
- `POST /sessions/:id/close`
- `POST /debts/:id/payments`
- `POST /debts/:id/mark-paid`
- `POST /debts/mark-paid`

Al reintentar tras un timeout, reusá la misma clave: si ya se aplicó, la API devuelve la respuesta guardada. Tras un error HTTP, la operación se revirtió y la clave quedó libre.

## Diferencias con el modelo local

| AsyncStorage | API |
|---|---|
| `Debt.sessionId` con `ajuste_previo` o `neteado` | `sourceType` (`session`, `manual`, `consolidated`) y `sessionId` null si no es de partida |
| `Debt.sessionName` | `label` |
| Sin parte manual | `manualAmount`, con signo respecto de from → to |
| Borrar compra por índice | `DELETE /sessions/:id/buys/:buyId` |
| `closeSession` sin validar | `close` con `confirmedDiff`; 409 `pot_mismatch` si la diferencia cambió |
| `getPlayers` con ajustes embebidos | Igual; `?includeArchived=true` suma archivados |

## Cierre de partida

1. `GET /sessions/:id` trae `calc` (`diff`, `status`) y `missingResults`.
2. Si `|diff| > 1` o faltan resultados, pedir confirmación.
3. `POST /sessions/:id/close` con `{ "confirmedDiff": diff }`.
4. Si responde 409 `pot_mismatch`, otro miembro cambió los montos: recargar y volver a confirmar.

## Datos para pantallas

| Pantalla | Rutas |
|---|---|
| Temporadas | `GET /seasons` (incluye conteos y líder) |
| Partidas | `GET /seasons/:seasonId/sessions` |
| Deudas de partida | `GET /sessions/:id/debts`; `state: "merged"` indica que se combinó con otras |
| Deudas pendientes | `GET /debts/pending-by-debtor`, `GET /debts/reorganize-status` |
| Stats | `GET /players/:id/stats`, `/report`, `/debts` |
| Ranking | `GET /ranking?seasonId=`; no incluye jugadores archivados, igual que el líder de temporada |

Los informes (`Reports`) no están expuestos todavía: la APK sigue calculándolos localmente hasta la etapa de informes.

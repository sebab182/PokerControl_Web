# Diseño web: versión 1

Actualiza `pokercontrol-web-design.md`, que queda como referencia. Donde difieren, vale este documento. El contrato HTTP vigente es [`openapi.yaml`](./openapi.yaml), que reemplaza al §8 de ese diseño.

## Alcance

Incluye las vistas de la APK, más login, onboarding y configuración. No incluye informes, sus gráficos, PDF, Home ni deploy. El único gráfico es `LineChart` en Stats.

## Rutas

| Ruta | Vista | Origen en la APK |
|---|---|---|
| `/login`, `/onboarding` | Google, crear o unirse a un grupo | Nuevas |
| `/join/:code` | Link de invitación: pide login si hace falta y confirma el ingreso | Nueva |
| `/` | Redirige a `/ranking` | En la APK la inicial es `SeasonsScreen` |
| `/seasons` | Temporadas | `SeasonsScreen` |
| `/seasons/:seasonId` | Partidas | `HomeScreen` |
| `/sessions/:sessionId` | Partida | `SessionScreen` |
| `/sessions/:sessionId/debts` | Deudas de la partida | `DebtScreen` |
| `/players` | Jugadores | `PlayersScreen` |
| `/players/:playerId/stats?seasonId=` | Estadísticas | `StatsScreen` |
| `/ranking?seasonId=` | Ranking: sin parámetro, la temporada activa (o el histórico si no hay); `seasonId=all`, el histórico | `RankingScreen` |
| `/debts` | Deudas pendientes | `PendingDebtsScreen` |
| `/settings` | Grupo, tema, backup, acerca de | `InfoModal` y nuevas |

Navegación: barra lateral desde 768 px y barra inferior debajo, con Ranking, Temporadas, Jugadores, Deudas y Config.

## Cambios al sistema visual

Los tokens del §2 del diseño original se mantienen, salvo los ajustes para contraste AA:

| Token | Modo | Antes | Ahora |
|---|---|---|---|
| `--green` | Claro | `#16A34A` | `#15803D` |
| `--amber` | Claro | `#D97706` | `#B45309` |
| `--red` | Claro | `#DC2626` | `#B91C1C` |
| `--text-muted` | Claro | `#6B7280` | `#5B6472` |
| `--text-muted` | Oscuro | `#8B93A1` | `#9AA2AF` |
| `--accent` | Oscuro | `#5B8DEF` | `#6C9AF2`, con texto oscuro encima |

Reglas de accesibilidad:
- El signo y el texto siempre acompañan al color.
- Emojis con `aria-hidden`.
- Modales Radix con foco y Escape, sin `window.confirm`.
- Áreas táctiles de 44 px como mínimo e inputs de 16 px con `inputmode="decimal"`.
- Safe areas, `prefers-reduced-motion` y foco visible.
- Tablas y gráfico con scroll propio, sin scroll horizontal de página.

## Comportamiento

- **Dinero:** sin updates optimistas en compras y pagos. El botón muestra spinner y la pantalla refleja lo que confirmó el servidor.
- **Reintentos:** ninguna mutación se reintenta sola. Ante un fallo de red aparece "Reintentar", que reusa la misma `Idempotency-Key`.
- **Multiusuario:** refetch al enfocar y polling de 15 s en partidas activas.
- **Red lenta:** si una request tarda más de 5 s aparece "Despertando el servidor".
- **Compartir:** `navigator.share`, luego `wa.me`, y además copia al portapapeles.
- **Montos:** un único parser acepta coma, punto y miles (`1.500,50`), con hasta 2 decimales.

## Reglas de negocio confirmadas

1. Solo una temporada activa por grupo. Crear o reabrir cierra la activa, sin error.
2. Se pueden agregar partidas a temporadas cerradas.
3. `diff = totalOut − totalPot`: negativo es "faltan". Se pide confirmar si `|diff| > 1` o si faltan resultados.
4. Los participantes sin resultado quedan fuera de las deudas.
5. Las partidas cerradas no se reabren ni se editan.
6. Con historial, un jugador se archiva; sin historial, se borra. Renombrarlo cambia también su pasado.
7. Un archivado sale de ranking y líderes, sigue en partidas pasadas y deudas, y no se puede sumar a partidas ni deudas manuales.
8. Roles globales: master (el primer usuario, nombra admins por email), admin (ve todos los grupos y modifica datos) y solo lectura (entra con invitación y elige su jugador). Ver [`apk-integration.md`](./apk-integration.md#roles).
8. Una consolidada acumula los pagos heredados y su estado es `partial`.
9. Solo la parte manual de una deuda (`manualAmount`) cuenta en `manualDebtsNet`.

## Paridad con la APK

| Función | Estado | Nota |
|---|---|---|
| Temporadas: crear, renombrar, cerrar, reabrir, borrar vacías, ordenar | ✅ | |
| Aviso de partidas abiertas al cerrar temporada | ✅ | |
| Partidas: crear con jugadores, Todos/Ninguno, borrar | ✅ | Borrar tiene el desvío 1 |
| Compras con timestamp, borrar cualquiera | ✅ | |
| Resultados editables mientras está activa | ✅ | |
| Cierre con diferencia | ✅ | |
| Pagos parciales con nota, saldar, historial, progreso | ✅ | |
| Deudas pendientes por deudor, reorganizar, deshacer | ✅ | |
| Deudas previas y ajustes legacy | ✅ | El alta de ajustes queda solo en la API, como en la APK |
| Saldar todo con un jugador | ✅ | Ahora atómico |
| Stats: balance, gráfico, mejor y peor, compras y rachas, historial | ✅ | |
| Ranking con podio, global o por temporada | ✅ | |
| Compartir por WhatsApp | ✅ | Partida, deudas pendientes y link de invitación |
| Backup: exportar e importar | ✅ | |
| Tema claro, oscuro y sistema | ✅ | |
| Reportes, premios, compartir premios, PDF | ⏳ | Etapa de informes |

## Desvíos respecto de la APK

1. **Borrar partidas:** responde 409 `session_debts_locked` si sus deudas tienen pagos o se consolidaron, porque dejaría plata sin origen. Para corregir, se usa una deuda manual compensatoria.
2. **Balances:** una consolidada con parte manual ya no suma dos veces el monto de partida, así que algunos balances históricos cambian.
3. **Pagos:** un pago mayor a lo pendiente se rechaza en la API (422), en lugar de recortarse.
4. **Eliminar jugador:** archiva si tiene historial.

## Paridad conservada a propósito

- Un neto menor a 1 entre dos jugadores elimina esas deudas, y su historial de pagos.
- `calcDebts` redondea las transferencias a enteros y es greedy.
- Se pueden crear partidas sin jugadores.

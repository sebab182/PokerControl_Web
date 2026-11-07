# Historial de manos

Cada mano de la mesa online queda guardada con lo necesario para analizar cómo juega cada uno. Se llena sola; no hay nada que
configurar. Las cartas de las manos terminadas (incluidas las de quien se retiró) están **solo en la base**: ningún endpoint las
expone todavía.

## Qué se guarda

| Tabla | Una fila por… | Contenido |
| --- | --- | --- |
| `poker_hands` | mano | partida (`session_id`), ciegas, pozo, board, calle en que terminó, si hubo showdown y el estado final completo (`state`, sin el mazo) |
| `poker_hand_players` | jugador y mano | posición, fichas y cartas con que empezó, y su resultado: aportado, cobrado, neto, calle en que se retiró, si vio el flop, VPIP, PFR, jugadas por tipo, all-in y showdown |
| `poker_actions` | jugada | quién, qué hizo (`kind`: `fold`, `check`, `call`, `raise`), monto, calle y la situación: pozo antes, cuánto había que igualar, fichas y rivales que quedaban |

- `kind`: un all-in cuenta como `raise` si subía la apuesta y como `call` si no. `amount` es lo igualado (`call`) o el total al que
  subió (`raise`).
- `position`: `BTN`, `SB`, `BB`, `UTG`, `UTG+1`…, `CO`; con dos jugadores `BTN/SB` y `BB`. `position_index` es la distancia al botón
  (0 = botón, 1 = ciega chica, 2 = ciega grande, 3 en adelante = primeros en hablar). Quien empezó sin fichas (`pending`) no tiene posición.
- `net = won − invested`: lo ganado o perdido en la mano, **sin** contar fichas compradas.
- `vpip`: puso fichas voluntariamente antes del flop (igualó o subió; las ciegas no cuentan). `pfr`: subió antes del flop.
- `pending`: se le repartió estando sin fichas y no veía sus cartas hasta recomprar; `bought_in_hand` son las fichas que compró para jugarla.
- `auto`/`auto_actions`: jugadas que hizo el servidor por tiempo agotado. Conviene excluirlas al estudiar el estilo de juego.

## Datos para el análisis de la partida

La pantalla «Análisis» (`GET /sessions/:id/analysis`, solo con la partida cerrada) usa además:

- `poker_hands.full_board`: el board completo, con las cartas que **no llegaron a salir** (se guardan al terminar la mano, antes de
  vaciar el mazo). Permite responder «¿y si no me retiraba?». Es `NULL` en manos anteriores.
- `poker_hand_players.hand_class` (`AKs`, `QTo`, `88`) y `card_score` (0–1, fuerza de las cartas iniciales, fórmula de Chen).
- `poker_hand_players.all_in_equity` y `ev_net`: probabilidad de ganar cuando quedó todo el dinero adentro y neto esperado según esa
  probabilidad (solo manos con all-in y showdown; los pozos laterales se reparten entre quienes pueden cobrarlos).
- `poker_actions.all_in` (la jugada dejó al jugador sin fichas) y `think_ms` (cuánto tardó en decidir, si la mesa tiene límite de tiempo).

Los indicadores (VPIP, PFR, 3-bet, c-bet, agresión, WTSD…) y el «qué hubiese pasado» se calculan en `packages/core/src/holdem/insights.ts`;
la equity, en `equity.ts` y `allin.ts`. `backfillHandInsights` completa `hand_class`, `card_score` y la equity de las manos ya guardadas.

## Manos anteriores

Las manos jugadas antes de que existiera este detalle se reconstruyen al arrancar la API (`backfillHandHistory`): quedan el
resultado, las cartas y la posición, pero **no** el detalle por calle. Esas filas tienen `has_street_data = false` y `vpip`, `pfr`,
`saw_flop`, `folded_street` y los contadores en `NULL`. Filtrá con `has_street_data` al calcular estadísticas.

## Consultas de ejemplo

```sql
-- VPIP y PFR por jugador (solo manos con detalle, sin jugadas automáticas ni pendientes)
select p.name,
       count(*)                                                    as manos,
       round(100.0 * count(*) filter (where hp.vpip) / count(*), 1) as vpip,
       round(100.0 * count(*) filter (where hp.pfr)  / count(*), 1) as pfr
from poker_hand_players hp
join players p on p.id = hp.player_id
where hp.has_street_data and not hp.pending and hp.auto_actions = 0
group by p.name
order by manos desc;

-- Ganancia neta y por mano según la posición
select hp.position, count(*) as manos, sum(hp.net) as neto, round(avg(hp.net), 1) as por_mano
from poker_hand_players hp
where hp.position is not null
group by hp.position
order by min(hp.position_index);

-- Showdown: cuántas veces llegó y cuántas ganó (por jugador)
select p.name,
       count(*) filter (where hp.showdown)                          as showdowns,
       count(*) filter (where hp.won_showdown)                      as ganados
from poker_hand_players hp
join players p on p.id = hp.player_id
group by p.name;

-- Agresión: (subidas) / (igualadas) por jugador
select p.name, sum(hp.raises) as subidas, sum(hp.calls) as igualadas,
       round(sum(hp.raises)::numeric / nullif(sum(hp.calls), 0), 2) as factor
from poker_hand_players hp
join players p on p.id = hp.player_id
where hp.has_street_data
group by p.name;

-- Cuánto se retira cada uno frente a una subida antes del flop
select p.name,
       count(*)                                            as veces,
       count(*) filter (where a.kind = 'fold')             as se_retiro
from poker_actions a
join poker_hands h on h.id = a.hand_id
join players p on p.id = a.player_id
where a.street = 'preflop' and a.to_call > 0 and not a.auto
group by p.name;

-- Una mano completa, jugada por jugada
select a.seq, p.name, a.street, a.kind, a.amount, a.pot_before, a.to_call, a.stack_before, a.players_left
from poker_actions a join players p on p.id = a.player_id
where a.hand_id = $1
order by a.seq;
```

## Cómo se completa

- Al repartir (`recordHandStart`): una fila por jugador con posición, fichas y cartas.
- En cada jugada (`playAction`): se guarda la situación en `poker_actions`.
- Al terminar (`recordHandResult`): se calcula el resumen con `summarizeHand` (`packages/core/src/holdem/analysis.ts`, puro y con
  tests) y se completan los datos de la mano y de cada jugador.

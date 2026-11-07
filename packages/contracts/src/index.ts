/**
 * Contrato HTTP de la API v1: única fuente para validación (Fastify), OpenAPI
 * y tipos de los clientes. La APK puede generar su cliente desde docs/openapi.yaml.
 */

import { Type as T, type Static, type TSchema } from '@sinclair/typebox';
import { TABLE_EMOJIS } from './emojis';

const Nullable = <S extends TSchema>(s: S) => T.Union([s, T.Null()]);
const Obj = <P extends Parameters<typeof T.Object>[0]>(p: P, id?: string) =>
  T.Object(p, { additionalProperties: false, ...(id ? { title: id } : {}) });

const Name = T.String({ minLength: 1, maxLength: 120 });
/** Monto > 0 con hasta 2 decimales (lo último se valida en la API). */
const PositiveAmount = T.Number({ exclusiveMinimum: 0, maximum: 9_999_999_999.99 });
const Amount = T.Number({ minimum: -9_999_999_999.99, maximum: 9_999_999_999.99 });

export const ErrorResponse = T.Object(
  { error: T.String(), message: T.String() },
  { additionalProperties: true, title: 'Error' },
);

// ─── Auth y grupos ───────────────────────────────────────────────────────────
export const Role = T.Union([T.Literal('master'), T.Literal('admin'), T.Literal('reader')]);
export const User = Obj({ id: T.String(), name: T.String(), email: T.String(), pictureUrl: Nullable(T.String()), role: Role }, 'User');
/** playerId: el jugador del usuario en ese grupo; null si todavía no eligió su nick. */
export const GroupRef = Obj({ id: T.String(), name: T.String(), playerId: Nullable(T.String()) }, 'GroupRef');
export const AuthResponse = Obj({ token: T.String(), user: User, groups: T.Array(GroupRef) }, 'AuthResponse');
export const GoogleLoginBody = Obj({ idToken: T.String({ minLength: 1 }) });
export const TokenResponse = Obj({ token: T.String() }, 'TokenResponse');
export const MeResponse = Obj({ user: User, groups: T.Array(GroupRef) }, 'MeResponse');

/** email e inviteCode solo llegan a master y admins. */
export const GroupMember = Obj({
  id: T.String(), name: T.String(), email: T.Optional(T.String()), joinedAt: T.String(), playerId: Nullable(T.String()),
}, 'GroupMember');
export const Group = Obj({
  id: T.String(), name: T.String(), inviteCode: Nullable(T.String()), timezone: T.String(), createdAt: T.String(),
  isMember: T.Boolean(), members: T.Array(GroupMember),
}, 'Group');
export const CreateGroupBody = Obj({ name: Name, timezone: T.Optional(T.String({ minLength: 1, maxLength: 64 })) });
export const UpdateGroupBody = Obj({ name: T.Optional(Name), timezone: T.Optional(T.String({ minLength: 1, maxLength: 64 })) });
export const JoinGroupBody = Obj({ inviteCode: T.String({ minLength: 4, maxLength: 16 }) });

// ─── Administradores ─────────────────────────────────────────────────────────
const Email = T.String({ maxLength: 320, pattern: '^[^\\s@]+@[^\\s@]+$' });
export const AdminOverview = Obj({
  users: T.Array(Obj({ id: T.String(), name: T.String(), email: T.String(), role: Role })),
  pending: T.Array(Obj({ email: T.String(), createdAt: T.String() })),
}, 'AdminOverview');
export const GrantAdminBody = Obj({ email: Email });
export const AdminEmailParams = Obj({ email: T.String() });

// ─── Jugadores ───────────────────────────────────────────────────────────────
export const PlayerAdjustment = Obj({ id: T.String(), description: T.String(), amount: T.Number(), date: T.String() }, 'PlayerAdjustment');
export const Player = Obj({
  id: T.String(), name: T.String(), createdAt: T.String(), archivedAt: Nullable(T.String()),
  linked: T.Boolean(), adjustments: T.Array(PlayerAdjustment),
}, 'Player');
export const CreatePlayerBody = Obj({ name: Name });
/** Exactamente uno: elegir un jugador libre o crear uno nuevo con ese nick. */
export const ClaimPlayerBody = Obj({ playerId: T.Optional(T.String()), name: T.Optional(Name) });
/** null primero: con coerceTypes, un string antes convertiría null en ''. */
export const LinkPlayerBody = Obj({ userId: T.Union([T.Null(), T.String()]) });
export const UpdatePlayerBody = Obj({ name: Name });
export const DeletePlayerResponse = Obj({ archived: T.Boolean() }, 'DeletePlayerResponse');
export const AdjustmentBody = Obj({ description: T.String({ maxLength: 200 }), amount: Amount });

const HistoryEntry = Obj({
  sessionId: T.String(), sessionName: T.String(), date: T.String(),
  totalBought: T.Number(), finalAmount: T.Number(), balance: T.Number(),
}, 'PlayerHistoryEntry');
const statsProps = {
  totalGames: T.Number(), wins: T.Number(), losses: T.Number(), ties: T.Number(), winRate: T.Number(),
  totalBalance: T.Number(), sessionBalance: T.Number(), adjustmentsTotal: T.Number(), manualDebtsNet: T.Number(),
  adjustments: T.Array(PlayerAdjustment), bestGame: Nullable(HistoryEntry), worstGame: Nullable(HistoryEntry),
  history: T.Array(HistoryEntry),
};
export const PlayerStats = Obj(statsProps, 'PlayerStats');
export const PlayerStatsResponse = Nullable(PlayerStats);
export const RankingEntry = Obj({ playerId: T.String(), name: T.String(), ...statsProps }, 'RankingEntry');

const SessionRef = Obj({ sessionId: T.String(), sessionName: T.String(), date: T.String() }, 'SessionRef');
export const PlayerReport = Obj({
  playerId: T.String(), games: T.Number(), avgBuysPerGame: T.Number(), rebuyRate: T.Number(), roi: T.Number(),
  lowestCumulative: T.Number(),
  recoveries: T.Array(Obj({
    lowestBalance: T.Number(), lowestAt: SessionRef, recoveredAt: SessionRef, gamesToRecover: T.Number(),
  })),
  nightComebacks: T.Number(), longestWinStreak: T.Number(), longestLossStreak: T.Number(),
  currentStreak: Obj({ type: T.Union([T.Literal('win'), T.Literal('loss'), T.Literal('none')]), count: T.Number() }),
}, 'PlayerReport');
export const PlayerReportResponse = Nullable(PlayerReport);

export const SeasonQuery = Obj({ seasonId: T.Optional(T.String()) });
export const PlayersQuery = Obj({ includeArchived: T.Optional(T.Boolean()) });

// ─── Temporadas ──────────────────────────────────────────────────────────────
const Status = T.Union([T.Literal('active'), T.Literal('closed')]);
export const Season = Obj({
  id: T.String(), name: T.String(), createdAt: T.String(), closedAt: Nullable(T.String()), status: Status,
  sessionCount: T.Number(), openSessionCount: T.Number(),
  leader: Nullable(Obj({ playerId: T.String(), name: T.String(), sessionBalance: T.Number() })),
}, 'Season');
export const CreateSeasonBody = Obj({ name: T.Optional(T.String({ maxLength: 120 })) });
export const RenameSeasonBody = Obj({ name: Name });

// ─── Partidas ────────────────────────────────────────────────────────────────
export const Buy = Obj({ id: T.String(), amount: T.Number(), timestamp: T.String() }, 'Buy');
export const Participant = Obj({
  playerId: T.String(), name: T.String(), buys: T.Array(Buy), finalAmount: Nullable(T.Number()),
}, 'Participant');
export const SessionCalc = Obj({
  totalPot: T.Number(), totalOut: T.Number(), diff: T.Number(),
  status: T.Union([T.Literal('ok'), T.Literal('faltan'), T.Literal('sobran')]),
}, 'SessionCalc');
export const Session = Obj({
  id: T.String(), name: T.String(), createdAt: T.String(), closedAt: Nullable(T.String()), status: Status,
  seasonId: T.String(), participants: T.Array(Participant), calc: SessionCalc, missingResults: T.Array(T.String()),
}, 'Session');
export const SessionSummary = Obj({
  id: T.String(), name: T.String(), createdAt: T.String(), status: Status, pot: T.Number(), playerCount: T.Number(),
}, 'SessionSummary');
export const CreateSessionBody = Obj({
  name: T.Optional(T.String({ maxLength: 120 })),
  playerIds: T.Array(T.String()),
  initialBuyIn: T.Optional(PositiveAmount),
  /** Saldo real de cada jugador antes de empezar; los que no vengan quedan en su último saldo conocido. */
  balances: T.Optional(T.Array(Obj({ playerId: T.String(), amount: Amount }))),
});
export const AddParticipantBody = Obj({ playerId: T.String() });
export const SetFinalAmountBody = Obj({ finalAmount: T.Number({ minimum: 0, maximum: 9_999_999_999.99 }) });
export const AddBuyBody = Obj({ playerId: T.String(), amount: PositiveAmount });
/** confirmedDiff: la diferencia que vio el usuario; si cambió, el cierre se rechaza. */
export const CloseSessionBody = Obj({
  confirmedDiff: T.Optional(T.Number()),
  /** Saldo real de cada jugador tras la partida; el resto queda en saldo previo + resultado. */
  balances: T.Optional(T.Array(Obj({ playerId: T.String(), amount: Amount }))),
});

// ─── Deudas ──────────────────────────────────────────────────────────────────
const PlayerRef = Obj({ id: T.String(), name: T.String() }, 'PlayerRef');
export const DebtPayment = Obj({ amount: T.Number(), date: T.String(), note: T.String() }, 'DebtPayment');
export const DebtStatus = T.Union([T.Literal('pending'), T.Literal('partial'), T.Literal('paid')]);
export const Debt = Obj({
  id: T.String(), fromPlayer: PlayerRef, toPlayer: PlayerRef, sessionId: Nullable(T.String()),
  sourceType: T.Union([T.Literal('session'), T.Literal('manual'), T.Literal('consolidated')]),
  label: T.String(), originalAmount: T.Number(), pendingAmount: T.Number(), status: DebtStatus,
  payments: T.Array(DebtPayment), createdAt: T.String(), isConsolidated: T.Boolean(), manualAmount: T.Number(),
}, 'Debt');
export const CloseSessionResponse = Obj({ session: Session }, 'CloseSessionResponse');

// ─── Saldos y pagos ──────────────────────────────────────────────────────────
/** balance > 0: le deben; < 0: debe. */
export const PlayerBalance = Obj({
  playerId: T.String(), name: T.String(), balance: T.Number(), archived: T.Boolean(),
}, 'PlayerBalance');
export const BalancePayment = Obj({
  id: T.String(), fromPlayer: PlayerRef, toPlayer: PlayerRef, amount: T.Number(), note: T.String(), createdAt: T.String(),
}, 'BalancePayment');
export const CreatePaymentBody = Obj({
  fromPlayerId: T.String(), toPlayerId: T.String(), amount: PositiveAmount, note: T.Optional(T.String({ maxLength: 200 })),
});
export const UpdateBalancesBody = Obj({
  balances: T.Array(Obj({ playerId: T.String(), amount: Amount }), { minItems: 1 }),
  note: T.Optional(T.String({ maxLength: 200 })),
});
export const PaymentParams = Obj({ groupId: T.String(), paymentId: T.String() });
export const DebtorGroup = Obj({ player: PlayerRef, debts: T.Array(Debt), totalPending: T.Number() }, 'DebtorGroup');
export const PlayerDebts = Obj({ owes: T.Array(Debt), owed: T.Array(Debt) }, 'PlayerDebts');
export const DebtsQuery = Obj({ sessionId: T.Optional(T.String()), status: T.Optional(DebtStatus) });
export const PaymentBody = Obj({ amount: PositiveAmount, note: T.Optional(T.String({ maxLength: 200 })) });
export const MarkPaidManyBody = Obj({ debtIds: T.Array(T.String(), { minItems: 1 }) });
export const ManualDebtBody = Obj({
  fromPlayerId: T.String(), toPlayerId: T.String(), amount: PositiveAmount,
  description: T.Optional(T.String({ maxLength: 200 })),
});
export const ReorganizeStatus = Obj({
  canReorganize: T.Boolean(), canUndo: T.Boolean(),
  reason: Nullable(T.Union([T.Literal('no_backup'), T.Literal('has_payments')])),
}, 'ReorganizeStatus');
export const SessionDebtsView = Obj({
  balances: T.Array(Obj({
    playerId: T.String(), name: T.String(),
    /** Resultado de la partida; null si no tiene resultado cargado. */
    result: Nullable(T.Number()),
    /** Saldo antes y después de la partida; null mientras está abierta. */
    before: Nullable(T.Number()), after: Nullable(T.Number()),
  })),
  allHaveResult: T.Boolean(),
  sessionStatus: Status,
}, 'SessionDebtsView');

// ─── Análisis de la partida (historial de manos) ────────────────────────────
const Street = T.Union([T.Literal('preflop'), T.Literal('flop'), T.Literal('turn'), T.Literal('river')]);
const ActionKindSchema = T.Union([T.Literal('fold'), T.Literal('check'), T.Literal('call'), T.Literal('raise')]);
const Cards = T.Array(T.String());
/** n de d oportunidades (d = 0: sin datos). */
const Rate = Obj({ n: T.Integer(), d: T.Integer() });

export const PlayerInsights = Obj({
  playerId: T.String(),
  hands: T.Integer(),
  net: T.Number(),
  bb100: T.Number(),
  vpip: Rate, pfr: Rate, threeBet: Rate, foldToThreeBet: Rate, cbet: Rate, foldToCbet: Rate, steal: Rate, bbDefend: Rate,
  aggression: Obj({ raises: T.Integer(), calls: T.Integer() }),
  aggressionFreq: Rate,
  wtsd: Rate, wsd: Rate, wwsf: Rate,
  avgPot: T.Number(),
  avgThinkMs: Nullable(T.Number()),
  avgCardScore: Nullable(T.Number()),
  byPosition: T.Array(Obj({ position: T.String(), hands: T.Integer(), net: T.Number(), netBB: T.Number() })),
  allIn: Obj({ hands: T.Integer(), net: T.Number(), evNet: T.Number() }),
}, 'PlayerInsights');

const SeriesPoint = Obj({ handNo: T.Integer(), values: T.Record(T.String(), T.Number()) });

export const HandRow = Obj({
  id: T.Integer(), handNo: T.Integer(), pot: T.Number(), board: Cards, endedOn: Street, wentToShowdown: T.Boolean(), bigBlind: T.Number(),
  players: T.Array(Obj({
    playerId: T.String(), position: Nullable(T.String()), hole: Cards, net: T.Number(), foldedStreet: Nullable(Street),
    showdown: T.Boolean(), pending: T.Boolean(),
  })),
  actions: T.Array(Obj({
    playerId: T.String(), street: Nullable(Street), kind: Nullable(ActionKindSchema), amount: Nullable(T.Number()),
    auto: T.Boolean(), allIn: T.Boolean(),
  })),
}, 'HandRow');

export const SessionAnalysis = Obj({
  /** Nombre de cada jugador por id. */
  names: T.Record(T.String(), T.String()),
  hands: T.Integer(),
  handsWithRunout: T.Integer(),
  players: T.Array(PlayerInsights),
  handRows: T.Array(HandRow),
  series: Obj({
    net: T.Array(SeriesPoint),
    evNet: T.Array(SeriesPoint),
    pot: T.Array(Obj({ handNo: T.Integer(), pot: T.Number(), endedOn: Street, showdown: T.Boolean() })),
    endedOn: Obj({ preflop: T.Integer(), flop: T.Integer(), turn: T.Integer(), river: T.Integer() }),
  }),
  whatIf: Obj({
    allIns: T.Array(Obj({
      handNo: T.Integer(), playerId: T.String(), equity: T.Number(), net: T.Number(), evNet: T.Number(), hole: Cards, board: Cards,
    })),
    folds: T.Array(Obj({
      handNo: T.Integer(), playerId: T.String(), street: Street, toCall: T.Number(), hole: Cards, board: Cards,
      result: T.Union([T.Literal('win'), T.Literal('tie'), T.Literal('lose')]), delta: T.Number(), auto: T.Boolean(),
    })),
    calls: T.Array(Obj({
      handNo: T.Integer(), playerId: T.String(), street: Street, toCall: T.Number(), committed: T.Number(), net: T.Number(), won: T.Boolean(),
    })),
    luck: T.Array(Obj({
      playerId: T.String(), allInHands: T.Integer(), net: T.Number(), evNet: T.Number(), luck: T.Number(),
      avgCardScore: Nullable(T.Number()), cardScoreVsTable: Nullable(T.Number()), vpipRate: Nullable(T.Number()),
    })),
  }),
}, 'SessionAnalysis');


// ─── Backup ──────────────────────────────────────────────────────────────────
/** Formato del backup de la APK. Los datos legacy se validan en la API. */
export const BackupFile = T.Object({
  exportedAt: T.Optional(T.String()),
  appVersion: T.Optional(T.String()),
  data: T.Object({
    poker_players: T.Array(T.Any()),
    poker_sessions: T.Array(T.Any()),
    poker_debts: T.Array(T.Any()),
    poker_seasons: T.Optional(T.Array(T.Any())),
  }, { additionalProperties: true }),
}, { additionalProperties: true, title: 'BackupFile' });
export const ImportQuery = Obj({ dryRun: T.Optional(T.Boolean()) });
export const ImportResult = Obj({
  dryRun: T.Boolean(),
  counts: Obj({
    players: T.Number(), archivedPlayers: T.Number(), adjustments: T.Number(), seasons: T.Number(),
    sessions: T.Number(), debts: T.Number(),
  }),
  warnings: T.Array(T.String()),
}, 'ImportResult');

// ─── Parámetros y respuestas simples ─────────────────────────────────────────
export const GroupParams = Obj({ groupId: T.String() });
export const IdParams = Obj({ groupId: T.String(), id: T.String() });
export const SeasonParams = Obj({ groupId: T.String(), seasonId: T.String() });
export const AdjustmentParams = Obj({ groupId: T.String(), id: T.String(), adjustmentId: T.String() });
export const ParticipantParams = Obj({ groupId: T.String(), id: T.String(), playerId: T.String() });
export const SeatParams = Obj({ groupId: T.String(), playerId: T.String() });
export const BuyParams = Obj({ groupId: T.String(), id: T.String(), buyId: T.String() });
export const Ok = Obj({ ok: T.Boolean() }, 'Ok');
export const Deleted = Obj({ deleted: T.Boolean() }, 'Deleted');

// ─── Mesa online (Texas Hold'em) ─────────────────────────────────────────────
const Chips = T.Integer({ minimum: 1, maximum: 1_000_000_000 });
export const TableStatus = T.Union([T.Literal('waiting'), T.Literal('playing')]);
export const TableSeat = Obj({
  playerId: T.String(), name: T.String(), stack: T.Integer(),
  status: T.Union([T.Literal('sitting'), T.Literal('out')]),
  /** Conectado: renovó su presencia hace pocos segundos (o lo sentó un administrador). */
  online: T.Boolean(), isYou: T.Boolean(),
  /** Un administrador puede jugar por él: es un jugador sin usuario. */
  managed: T.Boolean(),
  /** En esta partida: recompras (compras después de la entrada), fichas compradas en total y neto (fichas ahora menos compradas). */
  rebuys: T.Integer(), bought: T.Integer(), net: T.Integer(),
}, 'TableSeat');
export const HandPlayerView = Obj({
  playerId: T.String(), stack: T.Integer(), bet: T.Integer(), totalBet: T.Integer(),
  folded: T.Boolean(), allIn: T.Boolean(),
  /** Sin fichas: se le repartió pero no ve sus cartas ni juega hasta recomprar (solo puede retirarse). */
  pending: T.Boolean(),
  /** Tus cartas, las mostradas en el showdown, o "??" si están ocultas. */
  hole: T.Array(T.String()),
  /** Índices de `hole` que ven todos los de la mesa: el showdown o lo que el jugador decidió mostrar. */
  shown: T.Array(T.Integer()),
}, 'HandPlayerView');
export const LegalActionsView = Obj({
  toCall: T.Integer(), canCheck: T.Boolean(), canCall: T.Boolean(), callAmount: T.Integer(),
  canRaise: T.Boolean(), minRaiseTo: T.Integer(), maxRaiseTo: T.Integer(),
  /** Sin fichas: solo puede retirarse, o recomprar para jugar la mano. */
  mustBuy: T.Boolean(),
}, 'LegalActions');
export const HandView = Obj({
  handNo: T.Integer(),
  street: T.Union([T.Literal('preflop'), T.Literal('flop'), T.Literal('turn'), T.Literal('river'), T.Literal('done')]),
  board: T.Array(T.String()), pot: T.Integer(), currentBet: T.Integer(), minRaise: T.Integer(),
  button: T.Integer(), toActPlayerId: Nullable(T.String()),
  players: T.Array(HandPlayerView),
  /** Solo viene si es tu turno, o el de un jugador que manejás. */
  legal: Nullable(LegalActionsView),
  /** De quién son las acciones de `legal`: vos o un jugador sin usuario que manejás como administrador. */
  actingPlayerId: Nullable(T.String()),
  /** Última jugada de la mano. amount: lo igualado (call) o el total al que subió (raise, allin). */
  lastAction: Nullable(Obj({
    playerId: T.String(),
    type: T.Union([T.Literal('fold'), T.Literal('check'), T.Literal('call'), T.Literal('raise'), T.Literal('allin')]),
    amount: T.Optional(T.Integer()),
    /** true si la jugó el servidor por tiempo agotado. */
    auto: T.Optional(T.Boolean()),
  })),
  /**
   * Solo si hubo showdown: `reason`, por qué ganó, con la carta que desempata si hizo falta ("Doble par de jotas y
   * ochos, con as de kicker"); `cards`, las 5 cartas que forman su jugada (de la mesa y de su mano, que se muestra).
   */
  payouts: T.Array(Obj({
    playerId: T.String(), amount: T.Integer(), reason: T.Optional(T.String()), cards: T.Optional(T.Array(T.String())),
  })),
  showdown: T.Array(Obj({ playerId: T.String(), hole: T.Array(T.String()), handName: T.String() })),
}, 'HandView');
export const TableView = Obj({
  id: T.String(), status: TableStatus, sessionId: Nullable(T.String()),
  /** Ciegas de la mano en curso (o las que se usarán en la próxima). */
  smallBlind: T.Integer(), bigBlind: T.Integer(), buyIn: T.Integer(),
  /** Ciegas por tiempo: lo que se usará en la próxima mano, el nivel y cuándo sube (null si no hay más subidas). */
  blinds: Obj({
    minutes: T.Integer(), level: T.Integer(), small: T.Integer(), big: T.Integer(), atCap: T.Boolean(), nextAt: Nullable(T.String()),
  }, 'TableBlinds'),
  /** Cambia con cada acción: se envía de vuelta en POST /table/action. */
  version: T.Integer(),
  /** Segundos por turno (0 = sin límite) y vencimiento del turno en curso. */
  turnSeconds: T.Integer(),
  turnDeadline: Nullable(T.String()),
  /** Hora del servidor, para calcular la cuenta regresiva sin depender del reloj del cliente. */
  serverTime: T.String(),
  seats: T.Array(TableSeat),
  /** Tope de una recompra: la mitad de las fichas de quien más tiene en la mesa. */
  maxRebuy: T.Integer(),
  /** Tu jugador en este grupo; null si todavía no elegiste nick. */
  myPlayerId: Nullable(T.String()),
  /** Nombre de quien inició la partida, que es quien reparte y la cierra; null sin partida. */
  host: Nullable(T.String()),
  /** Si podés repartir la próxima mano y cerrar la partida: sos administrador o quien la inició (o esa persona ya no está en la mesa). */
  canHost: T.Boolean(),
  /** Vos iniciaste la partida: tu pantalla avisa que seguís (POST /table/ping) aunque no estés sentado. */
  isHost: T.Boolean(),
  hand: Nullable(HandView),
}, 'TableView');
// ─── Video de la mesa (señalización WebRTC por el WebSocket) ─────────────────
/**
 * start/stop: un jugador empieza o corta su transmisión (sin `to`: les llega a todos).
 * watch: un espectador le pide a quien transmite que le mande el video.
 * offer/answer/ice: negociación WebRTC punto a punto (con `to`).
 */
export const RtcKind = T.Union([
  T.Literal('start'), T.Literal('stop'), T.Literal('watch'),
  T.Literal('offer'), T.Literal('answer'), T.Literal('ice'),
]);
export const RtcClientMessage = Obj({
  type: T.Literal('rtc'), kind: RtcKind,
  /** Conexión destino (el `from` de un mensaje anterior). */
  to: T.Optional(T.String({ maxLength: 64 })),
  data: T.Optional(T.Unknown()),
}, 'RtcClientMessage');
export const RtcServerMessage = Obj({
  type: T.Literal('rtc'), kind: RtcKind,
  /** Conexión que lo envió, asignada por el servidor. */
  from: T.String(),
  /** Jugador de esa conexión; null si es un administrador sin jugador propio. */
  playerId: Nullable(T.String()),
  data: T.Optional(T.Unknown()),
}, 'RtcServerMessage');

/**
 * Paleta fija de emojis animados que se pueden mandar a la mesa. `id` es el código Unicode: así se llama su animación
 * en Noto Emoji Animation (Google). Solo viajan estos ids: nunca texto libre.
 */
export { TABLE_EMOJIS, type TableEmojiId } from './emojis';
const EmojiId = T.Union(TABLE_EMOJIS.map(e => T.Literal(e.id)));
export const EmojiClientMessage = Obj({ type: T.Literal('emoji'), id: EmojiId }, 'EmojiClientMessage');
export const EmojiServerMessage = Obj({
  type: T.Literal('emoji'), id: EmojiId,
  /** Jugador del que lo manda; null si no tiene (p. ej. un administrador que mira). */
  playerId: Nullable(T.String()),
  name: T.String({ maxLength: 60 }),
}, 'EmojiServerMessage');

export const StartTableBody = Obj({
  smallBlind: T.Optional(Chips), bigBlind: T.Optional(Chips), buyIn: T.Optional(Chips),
  /** 0 = sin límite; si no, entre 10 y 300 segundos. */
  turnSeconds: T.Optional(T.Integer({ minimum: 0, maximum: 300 })),
  /** Cada cuántos minutos se duplican las ciegas: 0 (nunca) o entre 5 y 120. */
  blindMinutes: T.Optional(T.Integer({ minimum: 0, maximum: 120 })),
});
export const TableActionBody = Obj({
  version: T.Integer(),
  /** Solo administradores: jugar por un jugador sin usuario. */
  playerId: T.Optional(T.String()),
  action: T.Union([
    Obj({ type: T.Literal('fold') }), Obj({ type: T.Literal('check') }), Obj({ type: T.Literal('call') }),
    Obj({ type: T.Literal('allin') }), Obj({ type: T.Literal('raise'), to: Chips }),
  ]),
});
export const RebuyBody = Obj({
  /** Fichas a comprar (hasta `maxRebuy`); si falta, la entrada o el tope si es menor. */
  amount: T.Optional(Chips),
});
export const RevealBody = Obj({
  /** Qué cartas mostrar (0 y/o 1); si falta, las dos. Mostrar una sola es solo del único jugador que queda. */
  cards: T.Optional(T.Array(T.Integer({ minimum: 0, maximum: 1 }), { minItems: 1, maxItems: 2, uniqueItems: true })),
  /** Solo administradores: mostrar las cartas de un jugador sin usuario. */
  playerId: T.Optional(T.String()),
});
export const CloseTableResponse = Obj({ sessionId: T.String(), table: TableView }, 'CloseTableResponse');

// ─── Tipos para clientes ─────────────────────────────────────────────────────
export type ApiRole = Static<typeof Role>;
export type ApiAdminOverview = Static<typeof AdminOverview>;
export type ApiUser = Static<typeof User>;
export type ApiGroupRef = Static<typeof GroupRef>;
export type ApiGroup = Static<typeof Group>;
export type ApiAuthResponse = Static<typeof AuthResponse>;
export type ApiPlayer = Static<typeof Player>;
export type ApiPlayerAdjustment = Static<typeof PlayerAdjustment>;
export type ApiPlayerStats = Static<typeof PlayerStats>;
export type ApiPlayerReport = Static<typeof PlayerReport>;
export type ApiRankingEntry = Static<typeof RankingEntry>;
export type ApiSeason = Static<typeof Season>;
export type ApiSession = Static<typeof Session>;
export type ApiParticipant = Static<typeof Participant>;
export type ApiSessionSummary = Static<typeof SessionSummary>;
export type ApiPlayerBalance = Static<typeof PlayerBalance>;
export type ApiBalancePayment = Static<typeof BalancePayment>;
export type ApiDebt = Static<typeof Debt>;
export type ApiDebtorGroup = Static<typeof DebtorGroup>;
export type ApiPlayerDebts = Static<typeof PlayerDebts>;
export type ApiReorganizeStatus = Static<typeof ReorganizeStatus>;
export type ApiSessionDebtsView = Static<typeof SessionDebtsView>;
export type ApiSessionAnalysis = Static<typeof SessionAnalysis>;
export type ApiPlayerInsights = Static<typeof PlayerInsights>;
export type ApiHandRow = Static<typeof HandRow>;
export type ApiImportResult = Static<typeof ImportResult>;
export type ApiCloseSessionResponse = Static<typeof CloseSessionResponse>;
export type ApiTableView = Static<typeof TableView>;
export type ApiHandView = Static<typeof HandView>;
export type ApiTableAction = Static<typeof TableActionBody>['action'];
export type ApiRtcKind = Static<typeof RtcKind>;
export type ApiRtcClientMessage = Static<typeof RtcClientMessage>;
export type ApiRtcServerMessage = Static<typeof RtcServerMessage>;
export type ApiEmojiServerMessage = Static<typeof EmojiServerMessage>;

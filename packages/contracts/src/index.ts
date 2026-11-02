/**
 * Contrato HTTP de la API v1: única fuente para validación (Fastify), OpenAPI
 * y tipos de los clientes. La APK puede generar su cliente desde docs/openapi.yaml.
 */

import { Type as T, type Static, type TSchema } from '@sinclair/typebox';

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
});
export const AddParticipantBody = Obj({ playerId: T.String() });
export const SetFinalAmountBody = Obj({ finalAmount: T.Number({ minimum: 0, maximum: 9_999_999_999.99 }) });
export const AddBuyBody = Obj({ playerId: T.String(), amount: PositiveAmount });
/** confirmedDiff: la diferencia que vio el usuario; si cambió, el cierre se rechaza. */
export const CloseSessionBody = Obj({ confirmedDiff: T.Optional(T.Number()) });

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
export const CloseSessionResponse = Obj({ session: Session, debts: T.Array(Debt) }, 'CloseSessionResponse');
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
    playerId: T.String(), name: T.String(), balance: Nullable(T.Number()),
  })),
  allHaveResult: T.Boolean(),
  sessionStatus: Status,
  items: T.Array(Obj({
    fromId: T.String(), fromName: T.String(), toId: T.String(), toName: T.String(), amount: T.Number(),
    state: T.Union([T.Literal('open'), T.Literal('merged')]),
    debt: Nullable(Debt),
  })),
}, 'SessionDebtsView');

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
export const BuyParams = Obj({ groupId: T.String(), id: T.String(), buyId: T.String() });
export const Ok = Obj({ ok: T.Boolean() }, 'Ok');
export const Deleted = Obj({ deleted: T.Boolean() }, 'Deleted');

// ─── Mesa online (Texas Hold'em) ─────────────────────────────────────────────
const Chips = T.Integer({ minimum: 1, maximum: 1_000_000_000 });
export const TableStatus = T.Union([T.Literal('waiting'), T.Literal('playing')]);
export const TableSeat = Obj({
  playerId: T.String(), name: T.String(), stack: T.Integer(),
  status: T.Union([T.Literal('sitting'), T.Literal('out')]),
  /** Conectado: renovó su presencia hace pocos segundos. */
  online: T.Boolean(), isYou: T.Boolean(),
}, 'TableSeat');
export const HandPlayerView = Obj({
  playerId: T.String(), stack: T.Integer(), bet: T.Integer(), totalBet: T.Integer(),
  folded: T.Boolean(), allIn: T.Boolean(),
  /** Tus cartas, las mostradas en el showdown, o "??" si están ocultas. */
  hole: T.Array(T.String()),
}, 'HandPlayerView');
export const LegalActionsView = Obj({
  toCall: T.Integer(), canCheck: T.Boolean(), canCall: T.Boolean(), callAmount: T.Integer(),
  canRaise: T.Boolean(), minRaiseTo: T.Integer(), maxRaiseTo: T.Integer(),
}, 'LegalActions');
export const HandView = Obj({
  handNo: T.Integer(),
  street: T.Union([T.Literal('preflop'), T.Literal('flop'), T.Literal('turn'), T.Literal('river'), T.Literal('done')]),
  board: T.Array(T.String()), pot: T.Integer(), currentBet: T.Integer(), minRaise: T.Integer(),
  button: T.Integer(), toActPlayerId: Nullable(T.String()),
  players: T.Array(HandPlayerView),
  /** Solo viene si es tu turno. */
  legal: Nullable(LegalActionsView),
  /** Última jugada de la mano. amount: lo igualado (call) o el total al que subió (raise, allin). */
  lastAction: Nullable(Obj({
    playerId: T.String(),
    type: T.Union([T.Literal('fold'), T.Literal('check'), T.Literal('call'), T.Literal('raise'), T.Literal('allin')]),
    amount: T.Optional(T.Integer()),
  })),
  payouts: T.Array(Obj({ playerId: T.String(), amount: T.Integer() })),
  showdown: T.Array(Obj({ playerId: T.String(), hole: T.Array(T.String()), handName: T.String() })),
}, 'HandView');
export const TableView = Obj({
  id: T.String(), status: TableStatus, sessionId: Nullable(T.String()),
  smallBlind: T.Integer(), bigBlind: T.Integer(), buyIn: T.Integer(),
  /** Cambia con cada acción: se envía de vuelta en POST /table/action. */
  version: T.Integer(),
  seats: T.Array(TableSeat),
  /** Tu jugador en este grupo; null si todavía no elegiste nick. */
  myPlayerId: Nullable(T.String()),
  hand: Nullable(HandView),
}, 'TableView');
export const StartTableBody = Obj({
  smallBlind: T.Optional(Chips), bigBlind: T.Optional(Chips), buyIn: T.Optional(Chips),
});
export const TableActionBody = Obj({
  version: T.Integer(),
  action: T.Union([
    Obj({ type: T.Literal('fold') }), Obj({ type: T.Literal('check') }), Obj({ type: T.Literal('call') }),
    Obj({ type: T.Literal('allin') }), Obj({ type: T.Literal('raise'), to: Chips }),
  ]),
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
export type ApiDebt = Static<typeof Debt>;
export type ApiDebtorGroup = Static<typeof DebtorGroup>;
export type ApiPlayerDebts = Static<typeof PlayerDebts>;
export type ApiReorganizeStatus = Static<typeof ReorganizeStatus>;
export type ApiSessionDebtsView = Static<typeof SessionDebtsView>;
export type ApiImportResult = Static<typeof ImportResult>;
export type ApiCloseSessionResponse = Static<typeof CloseSessionResponse>;
export type ApiTableView = Static<typeof TableView>;
export type ApiHandView = Static<typeof HandView>;
export type ApiTableAction = Static<typeof TableActionBody>['action'];

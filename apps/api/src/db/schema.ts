/**
 * Esquema PostgreSQL. Parte de PokerControl/db/schema.sql y agrega grupos.
 * Cada tabla de dominio lleva group_id, con FK compuestas (group_id, id) para
 * que la base impida referencias cruzadas entre grupos.
 */

import type { Action, HandState } from '@pokercontrol/core';
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, customType, foreignKey, index, integer, jsonb, pgTable, primaryKey, text,
  timestamp, unique, uniqueIndex,
} from 'drizzle-orm/pg-core';

/** NUMERIC(12,2) ↔ number: el driver lo entrega como string. */
export const money = customType<{ data: number; driverData: string }>({
  dataType: () => 'numeric(12, 2)',
  fromDriver: value => Number(value),
  toDriver: value => String(value),
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  pictureUrl: text('picture_url'),
  role: text('role').notNull().default('reader').$type<'master' | 'admin' | 'reader'>(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, t => [
  check('ck_users_role', sql`${t.role} in ('master', 'admin', 'reader')`),
  uniqueIndex('idx_users_single_master').on(t.role).where(sql`role = 'master'`),
]);

/** Admins nombrados por email antes de su primer login. */
export const adminGrants = pgTable('admin_grants', {
  email: text('email').primaryKey(),
  grantedBy: text('granted_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const groups = pgTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  inviteCode: text('invite_code').notNull().unique(),
  timezone: text('timezone').notNull().default('America/Argentina/Buenos_Aires'),
  createdBy: text('created_by').notNull().references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const groupMembers = pgTable('group_members', {
  groupId: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: ts('joined_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.groupId, t.userId] }), index('idx_group_members_user').on(t.userId)]);

export const players = pgTable('players', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
  archivedAt: ts('archived_at'),
}, t => [
  unique('uq_players_group_id').on(t.groupId, t.id),
  uniqueIndex('idx_players_group_user').on(t.groupId, t.userId),
  index('idx_players_group_archived').on(t.groupId, t.archivedAt),
]);

export const playerAdjustments = pgTable('player_adjustments', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull(),
  playerId: text('player_id').notNull(),
  description: text('description').notNull(),
  amount: money('amount').notNull(),
  occurredAt: ts('occurred_at').notNull(),
}, t => [
  foreignKey({ columns: [t.groupId, t.playerId], foreignColumns: [players.groupId, players.id], name: 'fk_adjustments_player' }).onDelete('cascade'),
  index('idx_player_adjustments_player').on(t.playerId),
]);

export const seasons = pgTable('seasons', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
  status: text('status').notNull().$type<'active' | 'closed'>(),
}, t => [
  unique('uq_seasons_group_id').on(t.groupId, t.id),
  check('ck_seasons_status', sql`${t.status} in ('active', 'closed')`),
  check('ck_seasons_closed', sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
  uniqueIndex('idx_seasons_single_active').on(t.groupId).where(sql`status = 'active'`),
]);

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  seasonId: text('season_id').notNull(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  closedAt: ts('closed_at'),
  status: text('status').notNull().$type<'active' | 'closed'>(),
}, t => [
  unique('uq_sessions_group_id').on(t.groupId, t.id),
  foreignKey({ columns: [t.groupId, t.seasonId], foreignColumns: [seasons.groupId, seasons.id], name: 'fk_sessions_season' }).onDelete('restrict'),
  check('ck_sessions_status', sql`${t.status} in ('active', 'closed')`),
  check('ck_sessions_closed', sql`(${t.status} = 'closed') = (${t.closedAt} is not null)`),
  index('idx_sessions_group_season').on(t.groupId, t.seasonId),
]);

export const sessionParticipants = pgTable('session_participants', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  groupId: text('group_id').notNull(),
  sessionId: text('session_id').notNull(),
  playerId: text('player_id').notNull(),
  finalAmount: money('final_amount'),
}, t => [
  unique('uq_participants_session_player').on(t.sessionId, t.playerId),
  foreignKey({ columns: [t.groupId, t.sessionId], foreignColumns: [sessions.groupId, sessions.id], name: 'fk_participants_session' }).onDelete('cascade'),
  foreignKey({ columns: [t.groupId, t.playerId], foreignColumns: [players.groupId, players.id], name: 'fk_participants_player' }).onDelete('restrict'),
  index('idx_participants_player').on(t.playerId),
]);

export const buys = pgTable('buys', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  participantId: bigint('participant_id', { mode: 'number' }).notNull()
    .references(() => sessionParticipants.id, { onDelete: 'cascade' }),
  amount: money('amount').notNull(),
  occurredAt: ts('occurred_at').notNull(),
}, t => [
  check('ck_buys_amount', sql`${t.amount} > 0`),
  index('idx_buys_participant').on(t.participantId),
]);

export const debts = pgTable('debts', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  fromPlayerId: text('from_player_id').notNull(),
  toPlayerId: text('to_player_id').notNull(),
  sessionId: text('session_id'),
  sourceType: text('source_type').notNull().$type<'session' | 'manual' | 'consolidated'>(),
  label: text('label').notNull(),
  originalAmount: money('original_amount').notNull(),
  pendingAmount: money('pending_amount').notNull(),
  manualAmount: money('manual_amount').notNull().default(0),
  status: text('status').notNull().$type<'pending' | 'partial' | 'paid'>(),
  isConsolidated: boolean('is_consolidated').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.groupId, t.fromPlayerId], foreignColumns: [players.groupId, players.id], name: 'fk_debts_from' }).onDelete('restrict'),
  foreignKey({ columns: [t.groupId, t.toPlayerId], foreignColumns: [players.groupId, players.id], name: 'fk_debts_to' }).onDelete('restrict'),
  foreignKey({ columns: [t.groupId, t.sessionId], foreignColumns: [sessions.groupId, sessions.id], name: 'fk_debts_session' }).onDelete('restrict'),
  check('ck_debts_source', sql`${t.sourceType} in ('session', 'manual', 'consolidated')`),
  check('ck_debts_status', sql`${t.status} in ('pending', 'partial', 'paid')`),
  check('ck_debts_original', sql`${t.originalAmount} > 0`),
  check('ck_debts_pending', sql`${t.pendingAmount} >= 0 and ${t.pendingAmount} <= ${t.originalAmount}`),
  check('ck_debts_players', sql`${t.fromPlayerId} <> ${t.toPlayerId}`),
  check('ck_debts_session', sql`(${t.sourceType} = 'session') = (${t.sessionId} is not null)`),
  index('idx_debts_group_status').on(t.groupId, t.status),
  index('idx_debts_session').on(t.sessionId),
  index('idx_debts_from').on(t.fromPlayerId),
  index('idx_debts_to').on(t.toPlayerId),
]);

export const debtPayments = pgTable('debt_payments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  debtId: text('debt_id').notNull().references(() => debts.id, { onDelete: 'cascade' }),
  amount: money('amount').notNull(),
  paidAt: ts('paid_at').notNull(),
  note: text('note').notNull().default(''),
}, t => [
  check('ck_payments_amount', sql`${t.amount} > 0`),
  index('idx_debt_payments_debt').on(t.debtId),
]);

/** Buffer de deshacer de una sola reorganización: como máximo una fila por grupo. */
export const debtBackups = pgTable('debt_backups', {
  groupId: text('group_id').primaryKey().references(() => groups.id, { onDelete: 'cascade' }),
  savedAt: ts('saved_at').notNull().defaultNow(),
  snapshot: jsonb('snapshot').notNull(),
  invalidatedReason: text('invalidated_reason'),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  groupId: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  status: integer('status'),
  response: jsonb('response'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.groupId, t.key] })]);

// ─── Mesa online (Texas Hold'em) ─────────────────────────────────────────────
// Una única mesa por grupo. Las fichas son enteros y valen 1:1 con pesos al cerrar.

export const pokerTables = pgTable('poker_tables', {
  id: text('id').primaryKey(),
  groupId: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('waiting').$type<'waiting' | 'playing'>(),
  /** Partida (sessions) a la que está ligada mientras se juega. */
  sessionId: text('session_id'),
  smallBlind: integer('small_blind').notNull().default(10),
  bigBlind: integer('big_blind').notNull().default(20),
  buyIn: integer('buy_in').notNull().default(1000),
  handCount: integer('hand_count').notNull().default(0),
  /** Índice (en orden de asiento) del botón de la última mano. */
  button: integer('button').notNull().default(0),
  /** Se incrementa en cada cambio visible: evita acciones sobre estados viejos. */
  version: integer('version').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
}, t => [
  unique('uq_poker_tables_group').on(t.groupId),
  unique('uq_poker_tables_group_id').on(t.groupId, t.id),
  foreignKey({ columns: [t.groupId, t.sessionId], foreignColumns: [sessions.groupId, sessions.id], name: 'fk_poker_tables_session' }).onDelete('restrict'),
  check('ck_poker_tables_status', sql`${t.status} in ('waiting', 'playing')`),
  check('ck_poker_tables_blinds', sql`${t.smallBlind} > 0 and ${t.bigBlind} >= ${t.smallBlind} and ${t.buyIn} > 0`),
  check('ck_poker_tables_session', sql`(${t.status} = 'playing') = (${t.sessionId} is not null)`),
]);

export const pokerSeats = pgTable('poker_seats', {
  tableId: text('table_id').notNull().references(() => pokerTables.id, { onDelete: 'cascade' }),
  playerId: text('player_id').notNull(),
  groupId: text('group_id').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Fichas en la mesa, fuera de la mano en curso. */
  stack: integer('stack').notNull().default(0),
  /** sitting: juega las próximas manos. out: se levantó pero sus fichas siguen en la mesa. */
  status: text('status').notNull().default('sitting').$type<'sitting' | 'out'>(),
  joinedAt: ts('joined_at').notNull().defaultNow(),
  /** Presencia: la web la renueva con cada join (heartbeat). */
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.tableId, t.playerId] }),
  foreignKey({ columns: [t.groupId, t.playerId], foreignColumns: [players.groupId, players.id], name: 'fk_poker_seats_player' }).onDelete('cascade'),
  check('ck_poker_seats_stack', sql`${t.stack} >= 0`),
  check('ck_poker_seats_status', sql`${t.status} in ('sitting', 'out')`),
]);

/** Una fila por mano. `state` guarda el mazo mientras la mano está activa; al terminar se vacía. */
export const pokerHands = pgTable('poker_hands', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tableId: text('table_id').notNull().references(() => pokerTables.id, { onDelete: 'cascade' }),
  handNo: integer('hand_no').notNull(),
  status: text('status').notNull().default('active').$type<'active' | 'done'>(),
  state: jsonb('state').notNull().$type<HandState>(),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
}, t => [
  unique('uq_poker_hands_table_no').on(t.tableId, t.handNo),
  check('ck_poker_hands_status', sql`${t.status} in ('active', 'done')`),
]);

export const pokerActions = pgTable('poker_actions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  handId: bigint('hand_id', { mode: 'number' }).notNull().references(() => pokerHands.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  playerId: text('player_id').notNull(),
  action: jsonb('action').notNull().$type<Action>(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, t => [unique('uq_poker_actions_hand_seq').on(t.handId, t.seq)]);

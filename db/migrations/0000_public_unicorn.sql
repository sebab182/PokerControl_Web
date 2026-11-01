CREATE TABLE "buys" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "buys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"participant_id" bigint NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_buys_amount" CHECK ("buys"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "debt_backups" (
	"group_id" text PRIMARY KEY NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"snapshot" jsonb NOT NULL,
	"invalidated_reason" text
);
--> statement-breakpoint
CREATE TABLE "debt_payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "debt_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"debt_id" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	CONSTRAINT "ck_payments_amount" CHECK ("debt_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "debts" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"from_player_id" text NOT NULL,
	"to_player_id" text NOT NULL,
	"session_id" text,
	"source_type" text NOT NULL,
	"label" text NOT NULL,
	"original_amount" numeric(12, 2) NOT NULL,
	"pending_amount" numeric(12, 2) NOT NULL,
	"manual_amount" numeric(12, 2) DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"is_consolidated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_debts_source" CHECK ("debts"."source_type" in ('session', 'manual', 'consolidated')),
	CONSTRAINT "ck_debts_status" CHECK ("debts"."status" in ('pending', 'partial', 'paid')),
	CONSTRAINT "ck_debts_original" CHECK ("debts"."original_amount" > 0),
	CONSTRAINT "ck_debts_pending" CHECK ("debts"."pending_amount" >= 0 and "debts"."pending_amount" <= "debts"."original_amount"),
	CONSTRAINT "ck_debts_players" CHECK ("debts"."from_player_id" <> "debts"."to_player_id"),
	CONSTRAINT "ck_debts_session" CHECK (("debts"."source_type" = 'session') = ("debts"."session_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"invite_code" text NOT NULL,
	"timezone" text DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_invite_code_unique" UNIQUE("invite_code")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"group_id" text NOT NULL,
	"key" text NOT NULL,
	"status" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_group_id_key_pk" PRIMARY KEY("group_id","key")
);
--> statement-breakpoint
CREATE TABLE "player_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"player_id" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "uq_players_group_id" UNIQUE("group_id","id")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"status" text NOT NULL,
	CONSTRAINT "uq_seasons_group_id" UNIQUE("group_id","id"),
	CONSTRAINT "ck_seasons_status" CHECK ("seasons"."status" in ('active', 'closed')),
	CONSTRAINT "ck_seasons_closed" CHECK (("seasons"."status" = 'closed') = ("seasons"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "session_participants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "session_participants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"group_id" text NOT NULL,
	"session_id" text NOT NULL,
	"player_id" text NOT NULL,
	"final_amount" numeric(12, 2),
	CONSTRAINT "uq_participants_session_player" UNIQUE("session_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"season_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"status" text NOT NULL,
	CONSTRAINT "uq_sessions_group_id" UNIQUE("group_id","id"),
	CONSTRAINT "ck_sessions_status" CHECK ("sessions"."status" in ('active', 'closed')),
	CONSTRAINT "ck_sessions_closed" CHECK (("sessions"."status" = 'closed') = ("sessions"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"picture_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
ALTER TABLE "buys" ADD CONSTRAINT "buys_participant_id_session_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."session_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_backups" ADD CONSTRAINT "debt_backups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debt_payments" ADD CONSTRAINT "debt_payments_debt_id_debts_id_fk" FOREIGN KEY ("debt_id") REFERENCES "public"."debts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "fk_debts_from" FOREIGN KEY ("group_id","from_player_id") REFERENCES "public"."players"("group_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "fk_debts_to" FOREIGN KEY ("group_id","to_player_id") REFERENCES "public"."players"("group_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "fk_debts_session" FOREIGN KEY ("group_id","session_id") REFERENCES "public"."sessions"("group_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_adjustments" ADD CONSTRAINT "fk_adjustments_player" FOREIGN KEY ("group_id","player_id") REFERENCES "public"."players"("group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "fk_participants_session" FOREIGN KEY ("group_id","session_id") REFERENCES "public"."sessions"("group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "fk_participants_player" FOREIGN KEY ("group_id","player_id") REFERENCES "public"."players"("group_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "fk_sessions_season" FOREIGN KEY ("group_id","season_id") REFERENCES "public"."seasons"("group_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_buys_participant" ON "buys" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "idx_debt_payments_debt" ON "debt_payments" USING btree ("debt_id");--> statement-breakpoint
CREATE INDEX "idx_debts_group_status" ON "debts" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "idx_debts_session" ON "debts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_debts_from" ON "debts" USING btree ("from_player_id");--> statement-breakpoint
CREATE INDEX "idx_debts_to" ON "debts" USING btree ("to_player_id");--> statement-breakpoint
CREATE INDEX "idx_group_members_user" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_player_adjustments_player" ON "player_adjustments" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "idx_players_group_archived" ON "players" USING btree ("group_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_seasons_single_active" ON "seasons" USING btree ("group_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_participants_player" ON "session_participants" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_group_season" ON "sessions" USING btree ("group_id","season_id");
CREATE TABLE "roulette_rounds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "roulette_rounds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"table_id" text NOT NULL,
	"session_id" text NOT NULL,
	"round_no" integer NOT NULL,
	"status" text DEFAULT 'betting' NOT NULL,
	"bets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ready" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" integer,
	"deltas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "uq_roulette_rounds_session_no" UNIQUE("session_id","round_no"),
	CONSTRAINT "ck_roulette_rounds_status" CHECK ("roulette_rounds"."status" in ('betting', 'done')),
	CONSTRAINT "ck_roulette_rounds_result" CHECK ("roulette_rounds"."result" is null or "roulette_rounds"."result" between 0 and 36)
);
--> statement-breakpoint
ALTER TABLE "poker_tables" DROP CONSTRAINT "ck_poker_tables_game";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "ck_sessions_game";--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "rou_min_bet" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "rou_max_bet" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "rou_bet_seconds" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "roulette_rounds" ADD CONSTRAINT "roulette_rounds_table_id_poker_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."poker_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roulette_rounds" ADD CONSTRAINT "roulette_rounds_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_roulette_rounds_table" ON "roulette_rounds" USING btree ("table_id","id");--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "ck_poker_tables_rou_bets" CHECK ("poker_tables"."rou_min_bet" >= 1 and "poker_tables"."rou_max_bet" >= "poker_tables"."rou_min_bet");--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "ck_poker_tables_rou_seconds" CHECK ("poker_tables"."rou_bet_seconds" between 10 and 300);--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "ck_poker_tables_game" CHECK ("poker_tables"."game" in ('holdem', 'blackjack', 'roulette'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "ck_sessions_game" CHECK ("sessions"."game" in ('poker', 'blackjack', 'roulette'));
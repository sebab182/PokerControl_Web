CREATE TABLE "blackjack_hands" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "blackjack_hands_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"table_id" text NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"player_id" text NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"state" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ck_blackjack_hands_kind" CHECK ("blackjack_hands"."kind" in ('solo', 'interlude')),
	CONSTRAINT "ck_blackjack_hands_status" CHECK ("blackjack_hands"."status" in ('active', 'done'))
);
--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "game" text DEFAULT 'holdem' NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "bj_min_bet" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "bj_interlude" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "bj_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "bj_queue" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "bj_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "bj_last" text;--> statement-breakpoint
ALTER TABLE "blackjack_hands" ADD CONSTRAINT "blackjack_hands_table_id_poker_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."poker_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blackjack_hands" ADD CONSTRAINT "blackjack_hands_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_blackjack_hands_table" ON "blackjack_hands" USING btree ("table_id","id");--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "ck_poker_tables_game" CHECK ("poker_tables"."game" in ('holdem', 'blackjack'));--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "ck_poker_tables_bj_min_bet" CHECK ("poker_tables"."bj_min_bet" >= 1);
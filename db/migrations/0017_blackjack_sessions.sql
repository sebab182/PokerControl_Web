ALTER TABLE "poker_tables" ADD COLUMN "bj_session_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "game" text DEFAULT 'poker' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "ck_sessions_game" CHECK ("sessions"."game" in ('poker', 'blackjack'));
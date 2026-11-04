ALTER TABLE "poker_tables" ADD COLUMN "blind_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "blinds_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "ck_poker_tables_blind_minutes" CHECK ("poker_tables"."blind_minutes" = 0 or "poker_tables"."blind_minutes" between 5 and 120);
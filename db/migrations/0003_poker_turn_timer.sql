ALTER TABLE "poker_seats" ADD COLUMN "timeouts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "turn_seconds" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "turn_deadline" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_poker_tables_deadline" ON "poker_tables" USING btree ("turn_deadline") WHERE turn_deadline is not null;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "ck_poker_tables_turn" CHECK ("poker_tables"."turn_seconds" = 0 or "poker_tables"."turn_seconds" between 10 and 300);
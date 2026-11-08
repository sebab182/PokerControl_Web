ALTER TABLE "sessions" DROP CONSTRAINT "ck_sessions_status";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "ck_sessions_closed";--> statement-breakpoint
ALTER TABLE "poker_tables" ADD COLUMN "show_all_cards" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "ck_sessions_status" CHECK ("sessions"."status" in ('active', 'closed', 'voided'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "ck_sessions_closed" CHECK (("sessions"."status" in ('closed', 'voided')) = ("sessions"."closed_at" is not null));
ALTER TABLE "poker_seats" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_seats" ADD COLUMN "added_by" text;--> statement-breakpoint
ALTER TABLE "poker_seats" ADD CONSTRAINT "poker_seats_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
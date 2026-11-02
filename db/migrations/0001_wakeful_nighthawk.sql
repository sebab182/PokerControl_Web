CREATE TABLE "admin_grants" (
	"email" text PRIMARY KEY NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "players" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'reader' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_grants" ADD CONSTRAINT "admin_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_players_group_user" ON "players" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_single_master" ON "users" USING btree ("role") WHERE role = 'master';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_role" CHECK ("users"."role" in ('master', 'admin', 'reader'));--> statement-breakpoint
-- El usuario mas antiguo es el master; el resto queda en solo lectura.
UPDATE "users" SET "role" = 'master' WHERE "id" = (SELECT "id" FROM "users" ORDER BY "created_at", "id" LIMIT 1);

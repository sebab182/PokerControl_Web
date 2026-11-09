ALTER TABLE "live_members" DROP CONSTRAINT "ck_live_members_role";--> statement-breakpoint
ALTER TABLE "live_photos" ADD COLUMN "street" text;--> statement-breakpoint
-- Los operadores de la primera versión pasan a ser «en la mesa».
UPDATE "live_members" SET "role" = 'table' WHERE "role" = 'operator';--> statement-breakpoint
ALTER TABLE "live_members" ADD CONSTRAINT "ck_live_members_role" CHECK ("live_members"."role" in ('remote', 'table'));--> statement-breakpoint
ALTER TABLE "live_photos" ADD CONSTRAINT "ck_live_photos_street" CHECK ("live_photos"."street" is null or "live_photos"."street" in ('flop', 'turn', 'river'));
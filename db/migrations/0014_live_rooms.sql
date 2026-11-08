CREATE TABLE "live_members" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"player_id" text,
	"role" text DEFAULT 'remote' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_members_room_id_user_id_pk" PRIMARY KEY("room_id","user_id"),
	CONSTRAINT "ck_live_members_role" CHECK ("live_members"."role" in ('remote', 'operator'))
);
--> statement-breakpoint
CREATE TABLE "live_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"hand_no" integer NOT NULL,
	"kind" text NOT NULL,
	"player_id" text,
	"bytes" "bytea" NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_live_photos_kind" CHECK ("live_photos"."kind" in ('board', 'hole')),
	CONSTRAINT "ck_live_photos_owner" CHECK (("live_photos"."kind" = 'hole') = ("live_photos"."player_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "live_rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"session_id" text NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"hand_no" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_live_rooms_session" UNIQUE("session_id"),
	CONSTRAINT "uq_live_rooms_code" UNIQUE("code"),
	CONSTRAINT "ck_live_rooms_status" CHECK ("live_rooms"."status" in ('open', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "live_members" ADD CONSTRAINT "live_members_room_id_live_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."live_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_members" ADD CONSTRAINT "live_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_photos" ADD CONSTRAINT "live_photos_room_id_live_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."live_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_rooms" ADD CONSTRAINT "live_rooms_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_rooms" ADD CONSTRAINT "fk_live_rooms_session" FOREIGN KEY ("group_id","session_id") REFERENCES "public"."sessions"("group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_live_photos_room" ON "live_photos" USING btree ("room_id");
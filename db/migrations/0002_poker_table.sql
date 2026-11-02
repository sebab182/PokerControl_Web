CREATE TABLE "poker_actions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "poker_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"hand_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"player_id" text NOT NULL,
	"action" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_poker_actions_hand_seq" UNIQUE("hand_id","seq")
);
--> statement-breakpoint
CREATE TABLE "poker_hands" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "poker_hands_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"table_id" text NOT NULL,
	"hand_no" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"state" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "uq_poker_hands_table_no" UNIQUE("table_id","hand_no"),
	CONSTRAINT "ck_poker_hands_status" CHECK ("poker_hands"."status" in ('active', 'done'))
);
--> statement-breakpoint
CREATE TABLE "poker_seats" (
	"table_id" text NOT NULL,
	"player_id" text NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"stack" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'sitting' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poker_seats_table_id_player_id_pk" PRIMARY KEY("table_id","player_id"),
	CONSTRAINT "ck_poker_seats_stack" CHECK ("poker_seats"."stack" >= 0),
	CONSTRAINT "ck_poker_seats_status" CHECK ("poker_seats"."status" in ('sitting', 'out'))
);
--> statement-breakpoint
CREATE TABLE "poker_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"session_id" text,
	"small_blind" integer DEFAULT 10 NOT NULL,
	"big_blind" integer DEFAULT 20 NOT NULL,
	"buy_in" integer DEFAULT 1000 NOT NULL,
	"hand_count" integer DEFAULT 0 NOT NULL,
	"button" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_poker_tables_group" UNIQUE("group_id"),
	CONSTRAINT "uq_poker_tables_group_id" UNIQUE("group_id","id"),
	CONSTRAINT "ck_poker_tables_status" CHECK ("poker_tables"."status" in ('waiting', 'playing')),
	CONSTRAINT "ck_poker_tables_blinds" CHECK ("poker_tables"."small_blind" > 0 and "poker_tables"."big_blind" >= "poker_tables"."small_blind" and "poker_tables"."buy_in" > 0),
	CONSTRAINT "ck_poker_tables_session" CHECK (("poker_tables"."status" = 'playing') = ("poker_tables"."session_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "poker_actions" ADD CONSTRAINT "poker_actions_hand_id_poker_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."poker_hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD CONSTRAINT "poker_hands_table_id_poker_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."poker_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_seats" ADD CONSTRAINT "poker_seats_table_id_poker_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."poker_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_seats" ADD CONSTRAINT "poker_seats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_seats" ADD CONSTRAINT "fk_poker_seats_player" FOREIGN KEY ("group_id","player_id") REFERENCES "public"."players"("group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "poker_tables_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_tables" ADD CONSTRAINT "fk_poker_tables_session" FOREIGN KEY ("group_id","session_id") REFERENCES "public"."sessions"("group_id","id") ON DELETE restrict ON UPDATE no action;
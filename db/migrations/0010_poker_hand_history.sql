CREATE TABLE "poker_hand_players" (
	"hand_id" bigint NOT NULL,
	"player_id" text NOT NULL,
	"group_id" text NOT NULL,
	"seat_order" integer NOT NULL,
	"position" text,
	"position_index" integer,
	"start_stack" integer NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"bought_in_hand" integer DEFAULT 0 NOT NULL,
	"hole" jsonb NOT NULL,
	"invested" integer,
	"won" integer,
	"net" integer,
	"folded_street" text,
	"saw_flop" boolean,
	"vpip" boolean,
	"pfr" boolean,
	"raises" integer,
	"calls" integer,
	"checks" integer,
	"folds" integer,
	"auto_actions" integer,
	"all_in" boolean,
	"showdown" boolean,
	"won_showdown" boolean,
	"has_street_data" boolean DEFAULT true NOT NULL,
	CONSTRAINT "poker_hand_players_hand_id_player_id_pk" PRIMARY KEY("hand_id","player_id")
);
--> statement-breakpoint
ALTER TABLE "poker_actions" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "poker_actions" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "poker_actions" ADD COLUMN "amount" integer;--> statement-breakpoint
ALTER TABLE "poker_actions" ADD COLUMN "pot_before" integer;--> statement-breakpoint
ALTER TABLE "poker_actions" ADD COLUMN "to_call" integer;--> statement-breakpoint
ALTER TABLE "poker_actions" ADD COLUMN "stack_before" integer;--> statement-breakpoint
ALTER TABLE "poker_actions" ADD COLUMN "players_left" integer;--> statement-breakpoint
ALTER TABLE "poker_actions" ADD COLUMN "auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "small_blind" integer;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "big_blind" integer;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "pot" integer;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "board" jsonb;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "ended_on" text;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "went_to_showdown" boolean;--> statement-breakpoint
ALTER TABLE "poker_hand_players" ADD CONSTRAINT "poker_hand_players_hand_id_poker_hands_id_fk" FOREIGN KEY ("hand_id") REFERENCES "public"."poker_hands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poker_hand_players" ADD CONSTRAINT "fk_poker_hand_players_player" FOREIGN KEY ("group_id","player_id") REFERENCES "public"."players"("group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_poker_hand_players_player" ON "poker_hand_players" USING btree ("player_id");--> statement-breakpoint
ALTER TABLE "poker_hands" ADD CONSTRAINT "poker_hands_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_poker_hands_session" ON "poker_hands" USING btree ("session_id");
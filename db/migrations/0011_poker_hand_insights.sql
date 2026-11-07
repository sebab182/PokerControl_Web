ALTER TABLE "poker_actions" ADD COLUMN "all_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_actions" ADD COLUMN "think_ms" integer;--> statement-breakpoint
ALTER TABLE "poker_hand_players" ADD COLUMN "hand_class" text;--> statement-breakpoint
ALTER TABLE "poker_hand_players" ADD COLUMN "card_score" real;--> statement-breakpoint
ALTER TABLE "poker_hand_players" ADD COLUMN "all_in_equity" real;--> statement-breakpoint
ALTER TABLE "poker_hand_players" ADD COLUMN "ev_net" real;--> statement-breakpoint
ALTER TABLE "poker_hands" ADD COLUMN "full_board" jsonb;
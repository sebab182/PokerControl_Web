CREATE TABLE "balance_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "balance_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"group_id" text NOT NULL,
	"player_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"session_id" text,
	"counterpart_player_id" text,
	"payment_id" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_balance_entries_kind" CHECK ("balance_entries"."kind" in ('adjustment', 'session', 'payment')),
	CONSTRAINT "ck_balance_entries_amount" CHECK ("balance_entries"."amount" <> 0)
);
--> statement-breakpoint
ALTER TABLE "balance_entries" ADD CONSTRAINT "balance_entries_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_entries" ADD CONSTRAINT "fk_balance_entries_player" FOREIGN KEY ("group_id","player_id") REFERENCES "public"."players"("group_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_entries" ADD CONSTRAINT "fk_balance_entries_session" FOREIGN KEY ("group_id","session_id") REFERENCES "public"."sessions"("group_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_balance_entries_player" ON "balance_entries" USING btree ("group_id","player_id");--> statement-breakpoint
CREATE INDEX "idx_balance_entries_payment" ON "balance_entries" USING btree ("payment_id");
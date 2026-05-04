ALTER TABLE "cases" ADD COLUMN "case_type" text DEFAULT 'mechanical' NOT NULL;
--> statement-breakpoint
CREATE TABLE "non_mechanical_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" integer,
	"case_id" integer,
	"category" text NOT NULL,
	"raw_signal" text NOT NULL,
	"safety_relevant" boolean DEFAULT false NOT NULL,
	"is_follow_up" boolean DEFAULT false NOT NULL,
	"response_type" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "non_mechanical_signals" ADD CONSTRAINT "non_mechanical_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_mechanical_signals" ADD CONSTRAINT "non_mechanical_signals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "non_mechanical_signals" ADD CONSTRAINT "non_mechanical_signals_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "non_mechanical_signals_user_idx" ON "non_mechanical_signals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "non_mechanical_signals_conversation_idx" ON "non_mechanical_signals" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "non_mechanical_signals_case_idx" ON "non_mechanical_signals" USING btree ("case_id");

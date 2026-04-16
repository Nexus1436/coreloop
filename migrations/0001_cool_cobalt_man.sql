CREATE TABLE "case_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"hypothesis_id" integer,
	"adjustment_type" text,
	"cue" text,
	"mechanical_focus" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_hypotheses" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"signal_id" integer,
	"hypothesis" text NOT NULL,
	"confidence" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"adjustment_id" integer,
	"result" text,
	"user_feedback" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"case_id" integer NOT NULL,
	"review_text" text NOT NULL,
	"structured" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"body_region" text,
	"signal_type" text,
	"movement_context" text,
	"activity_type" text,
	"description" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" integer,
	"movement_context" text,
	"activity_type" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" integer,
	"signal_type" text NOT NULL,
	"signal" text NOT NULL,
	"confidence" integer,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" integer NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"type" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" integer,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gym_id" integer;--> statement-breakpoint
ALTER TABLE "case_adjustments" ADD CONSTRAINT "case_adjustments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_adjustments" ADD CONSTRAINT "case_adjustments_hypothesis_id_case_hypotheses_id_fk" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."case_hypotheses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_hypotheses" ADD CONSTRAINT "case_hypotheses_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_hypotheses" ADD CONSTRAINT "case_hypotheses_signal_id_case_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."case_signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_outcomes" ADD CONSTRAINT "case_outcomes_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_outcomes" ADD CONSTRAINT "case_outcomes_adjustment_id_case_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."case_adjustments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reviews" ADD CONSTRAINT "case_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reviews" ADD CONSTRAINT "case_reviews_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_signals" ADD CONSTRAINT "case_signals_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_signals" ADD CONSTRAINT "case_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_signals" ADD CONSTRAINT "session_signals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_adjustments_case_idx" ON "case_adjustments" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_hypotheses_case_idx" ON "case_hypotheses" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_outcomes_case_idx" ON "case_outcomes" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_reviews_case_idx" ON "case_reviews" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_reviews_user_idx" ON "case_reviews" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "case_signals_case_idx" ON "case_signals" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "cases_user_idx" ON "cases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_signals_user_idx" ON "session_signals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transcripts_user_idx" ON "transcripts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transcripts_conversation_idx" ON "transcripts" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_user_idx" ON "messages" USING btree ("user_id");
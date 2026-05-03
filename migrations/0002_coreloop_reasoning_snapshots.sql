CREATE TABLE "case_reasoning_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"signal_id" integer,
	"active_hypothesis_id" integer,
	"active_adjustment_id" integer,
	"sport_domain" text,
	"activity_movement" text,
	"body_region" text,
	"movement_family" text,
	"mechanical_environment" text,
	"failure_candidates" jsonb,
	"dominant_failure" text,
	"dominant_failure_confidence" double precision,
	"active_lever" text,
	"active_test" text,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_reasoning_snapshots" ADD CONSTRAINT "case_reasoning_snapshots_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reasoning_snapshots" ADD CONSTRAINT "case_reasoning_snapshots_signal_id_case_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."case_signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reasoning_snapshots" ADD CONSTRAINT "case_reasoning_snapshots_active_hypothesis_id_case_hypotheses_id_fk" FOREIGN KEY ("active_hypothesis_id") REFERENCES "public"."case_hypotheses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reasoning_snapshots" ADD CONSTRAINT "case_reasoning_snapshots_active_adjustment_id_case_adjustments_id_fk" FOREIGN KEY ("active_adjustment_id") REFERENCES "public"."case_adjustments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_reasoning_snapshots_case_idx" ON "case_reasoning_snapshots" USING btree ("case_id");

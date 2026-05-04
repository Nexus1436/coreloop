ALTER TABLE "non_mechanical_signals"
ADD COLUMN IF NOT EXISTS "is_follow_up" boolean DEFAULT false NOT NULL;

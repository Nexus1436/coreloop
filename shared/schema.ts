import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  index,
  varchar,
  doublePrecision,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

/* =====================================================
   USERS
===================================================== */

export const users = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  profileImageUrl: varchar("profile_image_url"),
  gymId: integer("gym_id"),
  passwordHash: varchar("password_hash"),
  authProvider: varchar("auth_provider").notNull().default("coreloop"),
  externalId: varchar("external_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/* =====================================================
   CONVERSATIONS
===================================================== */

export const conversations = pgTable(
  "conversations",
  {
    id: serial("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    title: text("title").notNull(),

    summary: text("summary"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    userIdx: index("conversations_user_idx").on(table.userId),
  }),
);

/* =====================================================
   MESSAGES
===================================================== */

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),

    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    role: text("role").notNull(),

    content: text("content").notNull(),

    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    conversationIdx: index("messages_conversation_idx").on(
      table.conversationId,
    ),
    messageUserIdx: index("messages_user_idx").on(table.userId),
  }),
);

/* =====================================================
   TRANSCRIPTS
===================================================== */

export const transcripts = pgTable(
  "transcripts",
  {
    id: serial("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    conversationId: integer("conversation_id").references(
      () => conversations.id,
      { onDelete: "cascade" },
    ),

    content: text("content").notNull(),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    transcriptUserIdx: index("transcripts_user_idx").on(table.userId),
    transcriptConversationIdx: index("transcripts_conversation_idx").on(
      table.conversationId,
    ),
  }),
);

/* =====================================================
   USER MEMORY
===================================================== */

export const userMemory = pgTable(
  "user_memory",
  {
    id: serial("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    memory: jsonb("memory")
      .notNull()
      .default(sql`'{}'::jsonb`),

    updatedAt: timestamp("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    memoryUserIdx: index("user_memory_user_idx").on(table.userId),
  }),
);

/* =====================================================
   TIMELINE
===================================================== */

export const timelineEntries = pgTable("timeline_entries", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  conversationId: integer("conversation_id").notNull(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  type: text("type"),
  metadata: jsonb("metadata"),
});
/* =====================================================
   SESSION SIGNALS
===================================================== */

export const sessionSignals = pgTable(
  "session_signals",
  {
    id: serial("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    conversationId: integer("conversation_id").references(
      () => conversations.id,
      { onDelete: "cascade" },
    ),

    signalType: text("signal_type").notNull(),

    signal: text("signal").notNull(),

    confidence: integer("confidence"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    signalUserIdx: index("session_signals_user_idx").on(table.userId),
  }),
);

/* =====================================================
   CASES
===================================================== */

export const cases = pgTable(
  "cases",
  {
    id: serial("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    conversationId: integer("conversation_id").references(
      () => conversations.id,
      { onDelete: "cascade" },
    ),

    movementContext: text("movement_context"),
    activityType: text("activity_type"),
    caseType: text("case_type").default("mechanical").notNull(),

    status: text("status").default("open").notNull(),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),

    updatedAt: timestamp("updated_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    caseUserIdx: index("cases_user_idx").on(table.userId),
  }),
);

/* =====================================================
   NON-MECHANICAL SIGNALS
===================================================== */

export const nonMechanicalSignals = pgTable(
  "non_mechanical_signals",
  {
    id: serial("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    conversationId: integer("conversation_id").references(
      () => conversations.id,
      { onDelete: "cascade" },
    ),

    caseId: integer("case_id").references(() => cases.id, {
      onDelete: "cascade",
    }),

    category: text("category").notNull(),
    rawSignal: text("raw_signal").notNull(),
    safetyRelevant: boolean("safety_relevant").default(false).notNull(),
    isFollowUp: boolean("is_follow_up").default(false).notNull(),
    responseType: text("response_type"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    nonMechanicalSignalUserIdx: index(
      "non_mechanical_signals_user_idx",
    ).on(table.userId),
    nonMechanicalSignalConversationIdx: index(
      "non_mechanical_signals_conversation_idx",
    ).on(table.conversationId),
    nonMechanicalSignalCaseIdx: index(
      "non_mechanical_signals_case_idx",
    ).on(table.caseId),
  }),
);

/* =====================================================
   CASE REVIEWS
===================================================== */

export const caseReviews = pgTable(
  "case_reviews",
  {
    id: serial("id").primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),

    reviewText: text("review_text").notNull(),

    structured: jsonb("structured"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    caseReviewCaseIdx: index("case_reviews_case_idx").on(table.caseId),
    caseReviewUserIdx: index("case_reviews_user_idx").on(table.userId),
  }),
);

/* =====================================================
   CASE SIGNALS
===================================================== */

export const caseSignals = pgTable(
  "case_signals",
  {
    id: serial("id").primaryKey(),

    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),

    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    bodyRegion: text("body_region"),
    signalType: text("signal_type"),
    movementContext: text("movement_context"),
    activityType: text("activity_type"),
    description: text("description"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    caseSignalIdx: index("case_signals_case_idx").on(table.caseId),
  }),
);

/* =====================================================
   CASE HYPOTHESES
===================================================== */

export const caseHypotheses = pgTable(
  "case_hypotheses",
  {
    id: serial("id").primaryKey(),

    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),

    signalId: integer("signal_id").references(() => caseSignals.id, {
      onDelete: "set null",
    }),

    hypothesis: text("hypothesis").notNull(),
    confidence: text("confidence"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    caseHypothesisIdx: index("case_hypotheses_case_idx").on(table.caseId),
  }),
);

/* =====================================================
   CASE ADJUSTMENTS
===================================================== */

export const caseAdjustments = pgTable(
  "case_adjustments",
  {
    id: serial("id").primaryKey(),

    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),

    hypothesisId: integer("hypothesis_id").references(() => caseHypotheses.id, {
      onDelete: "set null",
    }),

    adjustmentType: text("adjustment_type"),
    cue: text("cue"),
    mechanicalFocus: text("mechanical_focus"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    caseAdjustmentIdx: index("case_adjustments_case_idx").on(table.caseId),
  }),
);

/* =====================================================
   CASE OUTCOMES
===================================================== */

export const caseOutcomes = pgTable(
  "case_outcomes",
  {
    id: serial("id").primaryKey(),

    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),

    adjustmentId: integer("adjustment_id").references(
      () => caseAdjustments.id,
      { onDelete: "set null" },
    ),

    result: text("result"),
    userFeedback: text("user_feedback"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    caseOutcomeIdx: index("case_outcomes_case_idx").on(table.caseId),
  }),
);

/* =====================================================
   CASE REASONING SNAPSHOTS
===================================================== */

export const caseReasoningSnapshots = pgTable(
  "case_reasoning_snapshots",
  {
    id: serial("id").primaryKey(),

    caseId: integer("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),

    signalId: integer("signal_id").references(() => caseSignals.id, {
      onDelete: "set null",
    }),

    activeHypothesisId: integer("active_hypothesis_id").references(
      () => caseHypotheses.id,
      { onDelete: "set null" },
    ),

    activeAdjustmentId: integer("active_adjustment_id").references(
      () => caseAdjustments.id,
      { onDelete: "set null" },
    ),

    sportDomain: text("sport_domain"),
    activityMovement: text("activity_movement"),
    bodyRegion: text("body_region"),
    movementFamily: text("movement_family"),
    mechanicalEnvironment: text("mechanical_environment"),
    failureCandidates: jsonb("failure_candidates"),
    dominantFailure: text("dominant_failure"),
    dominantFailureConfidence: doublePrecision(
      "dominant_failure_confidence",
    ),
    activeLever: text("active_lever"),
    activeTest: text("active_test"),

    createdAt: timestamp("created_at")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => ({
    caseReasoningCaseIdx: index("case_reasoning_snapshots_case_idx").on(
      table.caseId,
    ),
  }),
);

/* =====================================================
   INSERT SCHEMAS
===================================================== */

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export const insertTranscriptSchema = createInsertSchema(transcripts).omit({
  id: true,
  createdAt: true,
});

export const insertUserMemorySchema = createInsertSchema(userMemory).omit({
  id: true,
  updatedAt: true,
});

/* =====================================================
   TYPES
===================================================== */

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export type Transcript = typeof transcripts.$inferSelect;
export type InsertTranscript = z.infer<typeof insertTranscriptSchema>;

export type UserMemory = typeof userMemory.$inferSelect;
export type InsertUserMemory = z.infer<typeof insertUserMemorySchema>;

export type SessionSignal = typeof sessionSignals.$inferSelect;
export type NonMechanicalSignal = typeof nonMechanicalSignals.$inferSelect;
export type CaseReasoningSnapshot = typeof caseReasoningSnapshots.$inferSelect;

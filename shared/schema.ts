import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

import { users } from "./models/auth";

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

    role: text("role").notNull(), // "user" | "assistant"

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
  }),
);

/* =====================================================
   TRANSCRIPTS  ✅  (LANE 2 — DEBUG / AUDIT ONLY)
   This does NOT affect model memory or chat flow.
   This stores raw STT captures for developer inspection.
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

/* =====================================================
   AUTH EXPORT
===================================================== */

export * from "./models/auth";

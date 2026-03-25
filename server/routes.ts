// ==============================
// IMPORTS & SETUP
// ==============================

import { BASE_NARRATIVE } from "./prompts/baseNarrative";
import { BASE_NARRATIVE_V2 } from "./prompts/base_narrative_v2_claude";
import { CASE_REVIEW_NARRATIVE } from "./prompts/caseReviewNarrative";

import { isAuthenticated } from "./replit_integrations/auth";
import type { Express, Request, Response } from "express";
import type { Server as HTTPServer } from "http";

import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import { toFile } from "openai/uploads";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { eq, asc, desc, and, ne, isNull } from "drizzle-orm";

import { db } from "./db";

import {
  users,
  conversations,
  messages,
  sessionSignals,
  cases,
  caseSignals,
  caseHypotheses,
  caseAdjustments,
  caseOutcomes,
} from "@shared/schema";

import {
  getMemory,
  updateMemory,
  mergeExtracted,
  type InterloopMemory,
} from "./memory/memory";

import { extractMemory, extractSessionSignals } from "./memory/extract";
import { getSignalPatterns } from "./memory/signals";
import { generateSessionSummary } from "./memory/sessionSummary";
import { generateHypothesis } from "./memory/hypotheses";
import { registerAnalyticsRoutes } from "./analyticsRoutes";

// ==============================
// PROMPT VERSION CONTROL
// ==============================

const USE_V2 = true;

export const ACTIVE_BASE_NARRATIVE = USE_V2
  ? BASE_NARRATIVE_V2
  : BASE_NARRATIVE;

// ==============================
// EXTERNAL CLIENTS
// ==============================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

// ==============================
// UTILITY: TEXT CLAMP
// ==============================

function clampText(s: string, max = 800): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ==============================
// OUTCOME DETECTION
// ==============================

function detectOutcomeResult(
  text: string,
): "Improved" | "Worse" | "Same" | null {
  const input = text.trim();

  const improved =
    /\b(helped|worked|better|improved|fixed|that did it|feels better|much better|way better|significantly better|a lot better|relieved|less pain|less tight|lighter|smoother)\b/i;

  const worse =
    /\b(worse|hurt more|hurts more|pain increased|more pain|aggravated|made it worse|tighter|more tight|more strain|more uncomfortable)\b/i;

  const same =
    /\b(no change|same|still the same|didn't help|didnt help|no difference|not different|unchanged)\b/i;

  if (improved.test(input)) return "Improved";
  if (worse.test(input)) return "Worse";
  if (same.test(input)) return "Same";

  return null;
}

// ==============================
// STORED SESSION HISTORY BUILDER
// ==============================

async function getStoredSessionHistory(
  userId: string,
  currentConversationId: number,
): Promise<string> {
  const recentConvos = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        ne(conversations.id, currentConversationId),
      ),
    )
    .orderBy(desc(conversations.id))
    .limit(3);

  if (recentConvos.length === 0) return "";

  const sessionBlocks: string[] = [];

  for (const convo of recentConvos) {
    let block = `--- Session (conversation ${convo.id}, title: "${convo.title}") ---\n`;

    if (convo.summary) {
      block += `Summary: ${convo.summary}\n`;
    }

    const convoMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convo.id))
      .orderBy(asc(messages.createdAt))
      .limit(4);

    if (convoMessages.length > 0) {
      const lines = convoMessages
        .map(
          (m) =>
            `  ${m.role === "user" ? "User" : "Interloop"}: ${String(m.content ?? "")}`,
        )
        .join("\n");

      block += `\nKey Excerpts:\n${lines}`;
    }

    sessionBlocks.push(block);
  }

  return (
    "\n\n=== STORED SESSION HISTORY ===\n" +
    "Real prior conversations. Use when relevant.\n\n" +
    sessionBlocks.join("\n\n")
  );
}

// ==============================
// ACTIVE HYPOTHESIS LOOKUP
// ==============================

async function getActiveHypothesisBlock(userId: string): Promise<string> {
  const unresolved = await db
    .select({
      caseId: caseAdjustments.caseId,
      adjustmentId: caseAdjustments.id,
      cue: caseAdjustments.cue,
      mechanicalFocus: caseAdjustments.mechanicalFocus,
    })
    .from(caseAdjustments)
    .innerJoin(cases, eq(caseAdjustments.caseId, cases.id))
    .leftJoin(caseOutcomes, eq(caseAdjustments.id, caseOutcomes.adjustmentId))
    .where(and(eq(cases.userId, userId), isNull(caseOutcomes.id)))
    .orderBy(desc(caseAdjustments.id))
    .limit(1);

  if (unresolved.length === 0) return "";

  const latest = unresolved[0];

  return `
=== ACTIVE HYPOTHESIS (PRIORITY) ===
This is your active working hypothesis. Do not open new investigations until this is resolved or explicitly replaced.

Adjustment: ${latest.cue ?? "Previous movement adjustment"}
Mechanical focus: ${latest.mechanicalFocus ?? "Not specified"}

Your job: Test this hypothesis. Push for outcome clarity.
`;
}

// ==============================
// OUTCOME RECORDING
// ==============================

async function recordOutcomeIfDetected(
  userId: string,
  userText: string,
): Promise<void> {
  const result = detectOutcomeResult(userText);
  if (!result) return;

  const unresolved = await db
    .select({
      adjustmentId: caseAdjustments.id,
      caseId: caseAdjustments.caseId,
    })
    .from(caseAdjustments)
    .innerJoin(cases, eq(caseAdjustments.caseId, cases.id))
    .leftJoin(caseOutcomes, eq(caseAdjustments.id, caseOutcomes.adjustmentId))
    .where(and(eq(cases.userId, userId), isNull(caseOutcomes.id)))
    .orderBy(desc(caseAdjustments.id))
    .limit(1);

  if (unresolved.length === 0) return;

  const latest = unresolved[0];

  await db.insert(caseOutcomes).values({
    caseId: latest.caseId,
    adjustmentId: latest.adjustmentId,
    result,
    userFeedback: userText,
  });
}

// ==============================
// RESPONSE VALIDATION HELPERS
// ==============================

function isValidResponse(text: string): boolean {
  if (!text) return false;

  // EDIT 1: Light validation — only reject empty or extremely short
  if (text.trim().length < 40) return false;

  return true;
}

async function runCompletion(
  openaiClient: OpenAI,
  messages: ChatCompletionMessageParam[],
): Promise<string> {
  const resp = await openaiClient.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.4,
    messages,
  });

  return resp.choices?.[0]?.message?.content ?? "";
}

// ==============================
// ROUTE REGISTRATION
// ==============================

export async function registerRoutes(
  _httpServer: HTTPServer,
  app: Express,
): Promise<void> {
  // ==============================
  // ANALYTICS
  // ==============================

  registerAnalyticsRoutes(app);

  // ==============================
  // HEALTH CHECK
  // ==============================

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // ==============================
  // SPEECH-TO-TEXT
  // ==============================

  app.post("/api/stt", async (req: Request, res: Response) => {
    try {
      const { audio } = req.body;

      if (!audio) {
        return res.status(400).json({ error: "No audio provided" });
      }

      const buffer = Buffer.from(audio, "base64");

      const transcription = await openai.audio.transcriptions.create({
        file: await toFile(buffer, "speech.webm"),
        model: "whisper-1",
      });

      res.json({ transcript: transcription.text });
    } catch (error) {
      console.error("STT error:", error);
      res.status(500).json({ error: "STT failed" });
    }
  });

  // ==============================
  // TEXT-TO-SPEECH
  // ==============================

  let ttsQueue: Promise<string> = Promise.resolve("");

  app.post("/api/tts", async (req: Request, res: Response) => {
    try {
      const { text, voice } = req.body ?? {};
      if (!text || !text.trim()) {
        return res.status(400).json({ error: "No text provided" });
      }

      const voiceId =
        voice === "male" ? "3WZjQ5NUrKH37Zw6Vgp7" : "RjWJXbF7h9KPSuGnLo5x";

      const job = async () => {
        const audioStream = await elevenlabs.textToSpeech.convert(voiceId, {
          model_id: "eleven_multilingual_v2",
          text,
        });

        const chunks: Uint8Array[] = [];
        for await (const chunk of audioStream) chunks.push(chunk);

        return Buffer.concat(chunks).toString("base64");
      };

      ttsQueue = ttsQueue.then(job);
      const audioBase64 = await ttsQueue;

      res.json({ audio: audioBase64 });
    } catch (err) {
      console.error("ElevenLabs TTS error:", err);
      res.status(500).json({ error: "TTS failed" });
    }
  });

  // ==============================
  // MAIN CHAT PIPELINE
  // ==============================

  app.get("/api/conversations", isAuthenticated, async (req: any, res: any) => {
    try {
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      const results = await db
        .select()
        .from(conversations)
        .where(eq(conversations.userId, userId))
        .orderBy(desc(conversations.createdAt));

      res.json(results);
    } catch (err) {
      console.error("Failed to fetch conversations:", err);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  app.get(
    "/api/messages/:conversationId",
    isAuthenticated,
    async (req: any, res: any) => {
      try {
        const authUser = req.user as any;
        const userId = authUser?.claims?.sub;

        const conversationId = Number(req.params.conversationId);

        if (!Number.isFinite(conversationId)) {
          return res.status(400).json({ error: "Invalid conversationId" });
        }

        const [convo] = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.userId, userId),
            ),
          )
          .limit(1);

        if (!convo) {
          return res.status(404).json({ error: "Conversation not found" });
        }

        const results = await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(asc(messages.createdAt));

        res.json(results);
      } catch (err) {
        console.error("Failed to fetch messages:", err);
        res.status(500).json({ error: "Failed to fetch messages" });
      }
    },
  );

  app.post("/api/chat", async (req: Request, res: Response) => {
    try {
      // === AUTH ===
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      // === USER UPSERT ===
      const fullName = authUser?.claims?.name ?? "";
      const firstName =
        fullName && typeof fullName === "string"
          ? fullName.split(" ")[0]
          : null;

      const updateSet: Record<string, string | null> = {
        email: authUser?.claims?.email ?? null,
      };

      if (firstName) {
        updateSet.firstName = firstName;
      }

      await db
        .insert(users)
        .values({
          id: userId,
          email: authUser?.claims?.email ?? null,
          firstName,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: updateSet,
        });

      // === INPUT ===
      const {
        conversationId,
        messages: incoming,
        isCaseReview,
      } = req.body ?? {};

      console.log("isCaseReview:", isCaseReview);

      const last = incoming[incoming.length - 1];
      const userText = String(last?.content ?? "").trim();

      // === CONVERSATION (INITIAL) ===
      let convoId = Number(conversationId);

      if (!Number.isFinite(convoId)) {
        const [row] = await db
          .insert(conversations)
          .values({
            userId,
            title: clampText(userText, 60),
          })
          .returning();

        convoId = row.id;
      }

      // === LOAD HISTORY ===
      let previous = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, convoId))
        .orderBy(asc(messages.createdAt));

      // === CONVERSATION (RESET IF TOO LONG) ===
      if (previous.length > 20) {
        const [row] = await db
          .insert(conversations)
          .values({
            userId,
            title: clampText(userText, 60),
          })
          .returning();

        convoId = row.id;
        previous = [];
      }

      // === STORE USER MESSAGE ===
      await db.insert(messages).values({
        conversationId: convoId,
        role: "user",
        content: userText,
      });

      // include current user turn in history after storing
      previous = [
        ...previous,
        {
          id: 0,
          conversationId: convoId,
          role: "user",
          content: userText,
          createdAt: new Date(),
        } as any,
      ];

      // === CONTEXT ===
      const memory = await getMemory(userId);
      const memoryBlock =
        memory && Object.keys(memory).length > 0
          ? `=== USER MEMORY ===\n${JSON.stringify(memory, null, 0).slice(0, 1200)}`
          : "";

      const storedSessionHistory = "";

      const activeHypothesisBlock = await getActiveHypothesisBlock(userId);

      // === USER IDENTITY ===
      let [userRow] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      // tighter name detection (capture and allow correction when clearly introduced)
      const nameMatch = userText.match(
        /\b(?:my name is|i'm|i am|this is|it's|it is|name's)\s+([a-zA-Z]{2,20})\b/i,
      );

      if (nameMatch?.[1] && nameMatch[1].length > 2) {
        const possibleName =
          nameMatch[1].charAt(0).toUpperCase() +
          nameMatch[1].slice(1).toLowerCase();

        await db
          .update(users)
          .set({ firstName: possibleName })
          .where(eq(users.id, userId));

        [userRow] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
      }

      let identityBlock = "";

      if (!userRow?.firstName) {
        identityBlock = `=== FIRST INTERACTION PROTOCOL ===
      You do not know the user's name yet.

      If the user's name is unknown, integrate a brief and natural name request only when it fits inside the ongoing investigation.

      Do NOT ask as a standalone opening.
      Do NOT interrupt or derail the movement analysis.
      Do NOT prioritize identity over the investigation.

      The name request must feel secondary and embedded within the flow.`;
      } else {
        identityBlock = `=== USER IDENTITY ===
      User's first name is ${userRow.firstName}.

      The name is available and may be used when it adds meaningful emphasis inside the reasoning.
      Do not use it in every response.
      Use it no more than once in a response unless there is a strong reason.
      Do not default to placing it in the final sentence or final continuation.
      Its use must serve the reasoning rather than habit.`;
      }
      // === PROMPT SELECTION ===
      const ACTIVE_PROMPT = isCaseReview
        ? CASE_REVIEW_NARRATIVE
        : ACTIVE_BASE_NARRATIVE;

      // === MODEL INPUT ===
      const chatMessages: ChatCompletionMessageParam[] = [
        {
          role: "system",
          content: `
You must follow the instructions below exactly. These rules override all default behavior.

${ACTIVE_PROMPT}
          `.trim(),
        },
        {
          role: "system",
          content: `
Execution context for this conversation:

${identityBlock}

${memoryBlock}

${storedSessionHistory}

${activeHypothesisBlock}
          `.trim(),
        },
        ...previous.slice(-50).map((m) => ({
          role: m.role as "user" | "assistant",
          content: String(m.content ?? ""),
        })),
      ];

      // === RESPONSE PIPELINE ===
      // first pass (NON-STREAM)
      let assistantText = await runCompletion(openai, chatMessages);

      // === VALIDATION + RETRY ===
      if (!isCaseReview) {
        // detect weak / hedged responses
        const isWeak = /could be|might be|possibly|several|a few things/i.test(
          assistantText,
        );
        // detect explicit reasoning labels
        const hasLabels =
          /hypothesis:|guardrail:|lever:|sequence:|narrowing question:/i.test(
            assistantText,
          );
        // detect formatted section headers like **Something**:
        const hasFormattedSections = /\*\*.*\*\*:/g.test(assistantText);
        // detect segmented multi-block output
        const hasMultipleParagraphs = assistantText.split("\n\n").length > 2;

        if (
          !isValidResponse(assistantText) ||
          isWeak ||
          hasLabels ||
          hasFormattedSections ||
          hasMultipleParagraphs
        ) {
          const retryMessages: ChatCompletionMessageParam[] = [
            ...chatMessages,
            {
              role: "assistant",
              content: assistantText,
            },
            {
              role: "user",
              content: `
That response drifted from the active narrative. Rewrite it so the execution stays faithful to the base narrative.

Requirements:
- Restore a single dominant mechanism
- Remove hedging, genericness, segmentation, and multi-path advice
- Keep one line of reasoning and one path forward
- Do not list multiple explanations, drills, strategies, or branches
- Do not label sections or expose structure
- Do not use bolded headers, titles, or formatted section names
- The response must read as one continuous explanation, not packaged content
- Advance the investigation with one continuation only
- That continuation may appear as a question, conditional, contrast, or embedded test
- Do not force a question ending
- Avoid repeated ending patterns
- Do not force name usage
- If the user's name is used, it must not default to the final sentence or continuation
- Preserve the active base narrative rather than introducing a new runtime doctrine

Produce the corrected response now.
              `.trim(),
            },
          ];

          assistantText = await runCompletion(openai, retryMessages);
        }
      }

      // === STREAM FINAL ONLY ===
      res.setHeader("Content-Type", "text/event-stream");
      // simulate streaming (word by word)
      const words = assistantText.split(" ");

      for (const word of words) {
        res.write(`data: ${JSON.stringify({ content: word + " " })}\n\n`);
      }

      // === STORE RESPONSE ===
      await db.insert(messages).values({
        conversationId: convoId,
        role: "assistant",
        content: assistantText,
      });

      // === GENERATE + STORE SUMMARY ===
      try {
        console.log("SUMMARY USER TEXT:", userText);

        const summary = await generateSessionSummary(userText, []);
        console.log("SUMMARY OUTPUT:", summary);

        await db
          .update(conversations)
          .set({ summary })
          .where(eq(conversations.id, convoId));

        console.log("SUMMARY STORED FOR CONVERSATION:", convoId);
      } catch (err) {
        console.error("Summary generation failed:", err);
      }

      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ==============================
  // OUTCOME API
  // ==============================

  app.post("/api/outcome", async (req: Request, res: Response) => {
    try {
      const { caseId, adjustmentId, result, userFeedback } = req.body ?? {};

      if (!caseId || !result) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      await db.insert(caseOutcomes).values({
        caseId,
        adjustmentId: adjustmentId ?? null,
        result,
        userFeedback: userFeedback ?? null,
      });

      res.json({ ok: true });
    } catch (err) {
      console.error("Outcome capture failed:", err);
      res.status(500).json({ error: "Failed to store outcome" });
    }
  });
}

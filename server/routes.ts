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
  writeTimelineEntry,
  writeCaseReview,
  promoteTimelineToUserMemory,
  buildMemoryPromptBlock,
} from "./memory/memory";

import { generateSessionSummary } from "./memory/sessionSummary";
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

const INTERLOOP_TTS_CONFIG = {
  female: {
    voiceId: "RjWJXbF7h9KPSuGnLo5x",
    modelId: "eleven_multilingual_v2",
    settings: {
      stability: 0.36,
      similarity_boost: 0.78,
      style: 0.18,
      use_speaker_boost: false,
      speed: 1.08,
    },
  },
  male: {
    voiceId: "3WZjQ5NUrKH37Zw6Vgp7",
    modelId: "eleven_multilingual_v2",
    settings: {
      stability: 0.38,
      similarity_boost: 0.78,
      style: 0.15,
      use_speaker_boost: false,
      speed: 1.06,
    },
  },
} as const;

// ==============================
// UTILITY: TEXT CLAMP
// ==============================

function clampText(s: string, max = 800): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function normalizeStoredFirstName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatUnknownError(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) {
    return {
      error: err.message || "Unknown error",
      stack: err.stack,
    };
  }

  try {
    return {
      error: JSON.stringify(err),
    };
  } catch {
    return {
      error: String(err),
    };
  }
}

// ==============================
// FIRST INTERACTION HELPERS
// ==============================

function isGenericOpener(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ");

  const openers = new Set([
    "hi",
    "hello",
    "hey",
    "hey there",
    "hi there",
    "hello there",
    "good morning",
    "good evening",
    "good afternoon",
    "how are you",
    "whats up",
    "what's up",
    "yo",
    "sup",
  ]);

  return openers.has(normalized);
}

function extractConfidentExplicitName(text: string): string | null {
  const match = text.match(/\b(?:my name is|call me)\s+([A-Za-z]{2,20})\b/i);
  if (!match?.[1]) return null;

  const raw = match[1];
  const normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();

  const blacklist = new Set([
    "doing",
    "going",
    "trying",
    "working",
    "thinking",
    "me",
    "that",
    "this",
    "it",
    "here",
    "there",
    "something",
    "nothing",
    "anything",
    "everything",
    "today",
    "tomorrow",
    "yesterday",
  ]);

  if (blacklist.has(normalized.toLowerCase())) return null;

  return normalized;
}

function extractStandaloneNameReply(text: string): string | null {
  const trimmed = text.trim();

  if (!/^[A-Za-z]{2,20}$/.test(trimmed)) return null;

  const normalized =
    trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();

  const blacklist = new Set([
    "Hi",
    "Hey",
    "Hello",
    "Yo",
    "Sup",
    "Yes",
    "No",
    "Okay",
    "Ok",
    "Sure",
    "Thanks",
    "Thank",
    "Please",
    "Maybe",
    "Doing",
    "Going",
    "Trying",
    "Working",
    "Thinking",
  ]);

  if (blacklist.has(normalized)) return null;

  return normalized;
}

function askedWhatShouldICallYou(text: string): boolean {
  return /what should i call you\??/i.test(text);
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

function looksLikeAdjustment(text: string): boolean {
  return /\b(i tried|i changed|i started|i switched|i adjusted|i moved to|i began|i stopped|i reduced|i increased|i focused on|i worked on|i let|i allowed)\b/i.test(
    text.trim(),
  );
}

function looksLikeOutcome(text: string): boolean {
  return /\b(helped|worked|better|improved|worse|hurt more|hurts more|more pain|aggravated|same|no change|didn't help|didnt help|no difference|unchanged)\b/i.test(
    text.trim(),
  );
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
  registerAnalyticsRoutes(app);

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post("/api/stt", async (req: Request, res: Response) => {
    try {
      const { audio, mimeType } = req.body ?? {};

      if (!audio) {
        return res.status(400).json({ error: "No audio provided" });
      }

      const resolvedMimeType =
        typeof mimeType === "string" && mimeType.trim()
          ? mimeType.trim()
          : "audio/webm";

      const extension =
        resolvedMimeType.includes("mp4") || resolvedMimeType.includes("mpeg")
          ? "mp4"
          : resolvedMimeType.includes("wav")
            ? "wav"
            : resolvedMimeType.includes("ogg")
              ? "ogg"
              : "webm";

      const buffer = Buffer.from(audio, "base64");

      const transcription = await openai.audio.transcriptions.create({
        file: await toFile(buffer, `speech.${extension}`, {
          type: resolvedMimeType,
        }),
        model: "whisper-1",
      });

      res.json({ transcript: transcription.text });
    } catch (error) {
      console.error("STT error:", error);
      res.status(500).json({ error: "STT failed" });
    }
  });

  let ttsQueue: Promise<string> = Promise.resolve("");

  app.post("/api/tts", async (req: Request, res: Response) => {
    try {
      const { text, voice } = req.body ?? {};

      if (!text || !text.trim()) {
        return res.status(400).json({ error: "No text provided" });
      }

      const processedText = text.replace(/—/g, " — ").replace(/…/g, "... ");

      const selectedVoice =
        voice === "male"
          ? INTERLOOP_TTS_CONFIG.male
          : INTERLOOP_TTS_CONFIG.female;

      const job = async () => {
        let audioStream;

        try {
          audioStream = await elevenlabs.textToSpeech.convert(
            selectedVoice.voiceId,
            {
              model_id: selectedVoice.modelId,
              text: processedText.trim(),
              voice_settings: {
                stability: selectedVoice.settings.stability,
                similarity_boost: selectedVoice.settings.similarity_boost,
                style: selectedVoice.settings.style,
                use_speaker_boost: selectedVoice.settings.use_speaker_boost,
                speed: selectedVoice.settings.speed,
              },
            },
          );
        } catch (err) {
          audioStream = await elevenlabs.textToSpeech.convert(
            selectedVoice.voiceId,
            {
              model_id: selectedVoice.modelId,
              text: processedText.trim(),
              voice_settings: {
                stability: selectedVoice.settings.stability,
                similarity_boost: selectedVoice.settings.similarity_boost,
                style: selectedVoice.settings.style,
                use_speaker_boost: selectedVoice.settings.use_speaker_boost,
              },
            },
          );
        }

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

  // ==============================
  // MAIN CHAT PIPELINE
  // ==============================

  app.post(
    "/api/chat",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        console.log("CHAT STAGE: auth");

        const authUser = req.user as any;
        const userId = authUser?.claims?.sub;

        if (!userId) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        console.log("CHAT STAGE: request-parse");

        const body = req.body ?? {};
        const incomingRaw = body.messages;

        if (!Array.isArray(incomingRaw) || incomingRaw.length === 0) {
          return res.status(400).json({
            error: "Invalid request: messages must be a non-empty array",
          });
        }

        const incoming = incomingRaw.filter(
          (m: any) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string",
        );

        if (incoming.length === 0) {
          return res.status(400).json({
            error:
              "Invalid request: messages array does not contain any valid message objects",
          });
        }

        const last = incoming[incoming.length - 1];
        const userText = String(last?.content ?? "").trim();

        if (!userText) {
          return res.status(400).json({
            error: "Invalid request: latest message content is empty",
          });
        }

        const isCaseReview = Boolean(body.isCaseReview);
        console.log("CHAT MODE:", isCaseReview ? "CASE_REVIEW" : "STANDARD");

        const conversationId = body.conversationId;

        let [existingUser] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        const dbFirstName = normalizeStoredFirstName(existingUser?.firstName);

        if (!existingUser) {
          await db
            .insert(users)
            .values({
              id: userId,
              email: authUser?.claims?.email ?? null,
              firstName: null,
            })
            .onConflictDoUpdate({
              target: users.id,
              set: {
                email: authUser?.claims?.email ?? null,
              },
            });

          [existingUser] = await db
            .select()
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        } else {
          await db
            .update(users)
            .set({
              email: authUser?.claims?.email ?? null,
            })
            .where(eq(users.id, userId));
        }

        let convoId = Number(conversationId);

        console.log("CHAT STAGE: conversation-lookup");

        if (Number.isFinite(convoId)) {
          const [existing] = await db
            .select()
            .from(conversations)
            .where(eq(conversations.id, convoId))
            .limit(1);

          if (!existing || existing.userId !== userId) {
            return res
              .status(403)
              .json({ error: "Invalid conversation ownership" });
          }
        }

        console.log("CHAT STAGE: conversation-create");

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

        console.log("CHAT STAGE: prior-message-fetch");

        let previous = await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, convoId))
          .orderBy(asc(messages.createdAt));

        const hadMessagesInConversation = previous.length > 0;

        const [anyPriorUserMessage] = await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.userId, userId))
          .orderBy(asc(messages.createdAt))
          .limit(1);

        const isFirstRealInteraction =
          !anyPriorUserMessage && !hadMessagesInConversation;

        const lastAssistantMessage =
          [...previous].reverse().find((m) => m.role === "assistant") ?? null;

        const previousAssistantAskedName = Boolean(
          lastAssistantMessage &&
            askedWhatShouldICallYou(String(lastAssistantMessage.content ?? "")),
        );

        const explicitName = dbFirstName
          ? null
          : extractConfidentExplicitName(userText);
        const standaloneNameReply =
          !dbFirstName && previousAssistantAskedName
            ? extractStandaloneNameReply(userText)
            : null;

        let capturedName: string | null = null;

        if (!dbFirstName && explicitName) {
          capturedName = explicitName;
        } else if (!dbFirstName && standaloneNameReply) {
          capturedName = standaloneNameReply;
        }

        if (!dbFirstName && capturedName) {
          await db
            .update(users)
            .set({ firstName: capturedName })
            .where(eq(users.id, userId));

          [existingUser] = await db
            .select()
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        }

        await db.insert(messages).values({
          conversationId: convoId,
          userId: userId,
          role: "user",
          content: userText,
        });

        previous = [
          ...previous,
          {
            id: 0,
            conversationId: convoId,
            userId,
            role: "user",
            content: userText,
            createdAt: new Date(),
          } as any,
        ];

        const memory = await getMemory(userId);
        const memoryBlock = buildMemoryPromptBlock(memory);

        const storedSessionHistory = await getStoredSessionHistory(
          userId,
          convoId,
        );

        const activeHypothesisBlock = await getActiveHypothesisBlock(userId);

        let [userRow] = await db
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        const storedFirstName = normalizeStoredFirstName(userRow?.firstName);

        const shouldTriggerOnboarding =
          !storedFirstName &&
          isFirstRealInteraction &&
          isGenericOpener(userText);

        const isStandaloneNameFollowup =
          !storedFirstName &&
          Boolean(standaloneNameReply) &&
          Boolean(lastAssistantMessage) &&
          previousAssistantAskedName;

        let identityBlock = "";

        // ==============================
        // FIRST INTERACTION PROTOCOL
        // ==============================

        if (shouldTriggerOnboarding) {
          identityBlock = `=== FIRST INTERACTION PROTOCOL ===
This is the user's first real interaction.
The current message is only a generic opener, not a substantive issue.
Deliver the onboarding message now.
End that onboarding message with this exact question:
What should I call you?

Do not start movement analysis yet.
Do not skip the onboarding message.
Do not replace the final question with a different wording.`;
        } else if (!storedFirstName && isStandaloneNameFollowup) {
          identityBlock = `=== FIRST INTERACTION PROTOCOL ===
The user just replied to your onboarding name question with a standalone name.
Treat that reply as identity confirmation, not as a movement problem to analyze.
Acknowledge the name naturally and continue forward without asking for the name again.
Do not turn this one-word reply into issue analysis.`;
        } else if (!storedFirstName) {
          identityBlock = `=== FIRST INTERACTION PROTOCOL ===
You do not know the user's name yet.

If the current message is substantive, engage the issue directly.
Do NOT force the onboarding speech first.
Do NOT interrupt or derail the investigation with a standalone name question.

You may ask for the user's name later only when it fits naturally inside the ongoing flow.`;
        } else {
          identityBlock = `=== USER IDENTITY ===
User's first name is ${storedFirstName}.

The name is available and may be used when it adds meaningful emphasis inside the reasoning.
Do not use it in every response.
Use it no more than once in a response unless there is a strong reason.
Do not default to placing it in the final sentence or final continuation.
Its use must serve the reasoning rather than habit.`;
        }

        const ACTIVE_PROMPT = isCaseReview
          ? CASE_REVIEW_NARRATIVE
          : ACTIVE_BASE_NARRATIVE;

        console.log("CHAT STAGE: prompt-assembly");

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

        console.log("CHAT STAGE: openai-completion");

        let assistantText = await runCompletion(openai, chatMessages);

        if (!isCaseReview && !shouldTriggerOnboarding) {
          const isWeak =
            /could be|might be|possibly|several|a few things/i.test(
              assistantText,
            );

          const hasLabels =
            /hypothesis:|guardrail:|lever:|sequence:|narrowing question:/i.test(
              assistantText,
            );

          const hasFormattedSections = /\*\*.*\*\*:/g.test(assistantText);
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

        res.setHeader("Content-Type", "text/event-stream");

        const words = assistantText.split(" ");

        for (const word of words) {
          res.write(`data: ${JSON.stringify({ content: word + " " })}\n\n`);
        }

        console.log("CHAT STAGE: assistant-message-insert");

        await db.insert(messages).values({
          conversationId: convoId,
          userId: userId,
          role: "assistant",
          content: assistantText,
        });

        try {
          console.log("CASE REVIEW WRITE CHECK:", {
            isCaseReview,
            assistantLength: assistantText.length,
            userId,
          });

          if (isCaseReview && assistantText.length > 60) {
            const [latestCase] = await db
              .select()
              .from(cases)
              .where(eq(cases.userId, userId))
              .orderBy(desc(cases.id))
              .limit(1);

            console.log("LATEST CASE FOR REVIEW:", latestCase?.id ?? null);

            if (latestCase) {
              await writeCaseReview({
                userId,
                caseId: latestCase.id,
                reviewText: assistantText,
              });

              console.log("CASE REVIEW STORED:", latestCase.id);
            } else {
              console.warn(
                "CASE REVIEW SKIPPED: no existing case found for user",
                userId,
              );
            }
          }
        } catch (err) {
          console.error("Case review write failed:", err);
        }

        try {
          const shouldWriteTimeline =
            userText.length > 40 &&
            /pain|tight|hurt|issue|problem|can't|cannot|struggle|confused|off/i.test(
              userText,
            );

          if (shouldWriteTimeline) {
            await writeTimelineEntry({
              userId,
              conversationId: convoId,
              type: "signal",
              summary: userText,
            });
          }
        } catch (err) {
          console.error("Timeline write failed:", err);
        }

        try {
          const shouldWriteAdjustment =
            userText.length > 30 && looksLikeAdjustment(userText);

          if (shouldWriteAdjustment) {
            await writeTimelineEntry({
              userId,
              conversationId: convoId,
              type: "adjustment",
              summary: userText,
            });
          }
        } catch (err) {
          console.error("Adjustment timeline write failed:", err);
        }

        try {
          const shouldWriteOutcome =
            userText.length > 20 && looksLikeOutcome(userText);

          if (shouldWriteOutcome) {
            await writeTimelineEntry({
              userId,
              conversationId: convoId,
              type: "outcome",
              summary: userText,
            });
          }
        } catch (err) {
          console.error("Outcome timeline write failed:", err);
        }

        try {
          await promoteTimelineToUserMemory(userId);
        } catch (err) {
          console.error("User memory promotion failed:", err);
        }

        try {
          const summary = await generateSessionSummary(userText, []);

          await db
            .update(conversations)
            .set({ summary })
            .where(eq(conversations.id, convoId));
        } catch (err) {
          console.error("Summary generation failed:", err);
        }

        res.write(`data: [DONE]\n\n`);
        res.end();
      } catch (err) {
        console.error("CHAT ERROR:", err);
        const formatted = formatUnknownError(err);
        res.status(500).json(formatted);
      }
    },
  );

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

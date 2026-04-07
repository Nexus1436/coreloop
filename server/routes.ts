// ==============================
// IMPORTS & SETUP
// ==============================

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

export const ACTIVE_BASE_NARRATIVE = BASE_NARRATIVE_V2;

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
      similarity_boost: 0.85,
      style: 0.18,
      use_speaker_boost: true,
      speed: 1.08,
    },
  },
  male: {
    voiceId: "3WZjQ5NUrKH37Zw6Vgp7",
    modelId: "eleven_multilingual_v2",
    settings: {
      stability: 0.38,
      similarity_boost: 0.85,
      style: 0.15,
      use_speaker_boost: true,
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
  if (!trimmed || /^null$/i.test(trimmed)) return null;
  return trimmed;
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

function normalizeCaseKey(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isFallbackMovementContext(value: string | null | undefined): boolean {
  return normalizeCaseKey(value) === "general movement";
}

function isFallbackActivityType(value: string | null | undefined): boolean {
  return normalizeCaseKey(value) === "unspecified";
}

function hasStrongDerivedCaseContext(context: {
  movementContext: string;
  activityType: string;
}): boolean {
  return (
    !isFallbackMovementContext(context.movementContext) &&
    !isFallbackActivityType(context.activityType)
  );
}

function qualifiesForTimelineSignal(text: string): boolean {
  return /\b(?:pain|hurt|hurts|hurting|tight|tightness|issue|problem|bother|bothering|can't|cannot|struggle|confused|off|feels?\s+off|feels?\s+weird|not\s+right|unstable|off\s+today|out\s+of\s+sync|awkward|not\s+moving\s+cleanly|something\s+is\s+off|movement\s+feels\s+wrong|body\s+part\s+not\s+working\s+right|not\s+working|doesn't\s+feel\s+right|doesnt\s+feel\s+right|can't\s+rotate|cant\s+rotate|can't\s+load|cant\s+load|timing\s+is\s+off|timing\s+feels\s+off|mechanics\s+feel\s+wrong|movement\s+is\s+weird|doesn't\s+feel\s+stable|not\s+stable|out\s+of\s+position|can't\s+control|cant\s+control|not\s+coordinated|coordination\s+is\s+off|rotation\s+feels\s+off|trunk\s+rotation\s+feels\s+wrong|(?:shoulder|hip|back|knee|arm|trunk)\s+feels?\s+off|(?:shoulder|hip|back|knee|arm|trunk)\s+feels?\s+weird|(?:shoulder|hip|back|knee|arm|trunk)\s+.*out\s+of\s+sync|(?:shoulder|hip|back|knee|arm|trunk)\s+.*not\s+working\s+right)\b/i.test(
    text.trim(),
  );
}

function isPureOutcomeFollowUp(text: string): boolean {
  return looksLikeOutcome(text) && !qualifiesForTimelineSignal(text);
}

function deriveCaseContext(text: string): {
  movementContext: string;
  activityType: string;
} {
  const input = text.trim();

  const activityPatterns: Array<{ label: string; regex: RegExp }> = [
    { label: "racquetball", regex: /\bracquetball\b/i },
    { label: "running", regex: /\brun(?:ning)?\b/i },
    { label: "walking", regex: /\bwalk(?:ing)?\b/i },
    { label: "squat", regex: /\bsquat(?:ting)?\b/i },
    { label: "deadlift", regex: /\bdeadlift(?:ing)?\b/i },
    { label: "lunge", regex: /\blunge(?:s|ing)?\b/i },
    { label: "serve", regex: /\bserve|serving\b/i },
    { label: "swing", regex: /\bswing|swinging\b/i },
    { label: "rotation", regex: /\brotate|rotation|turning\b/i },
    { label: "hinge", regex: /\bhinge|hinging\b/i },
    { label: "reach", regex: /\breach|reaching\b/i },
    { label: "lifting", regex: /\blift|lifting\b/i },
  ];

  const detectedActivity =
    activityPatterns.find((entry) => entry.regex.test(input))?.label ??
    "unspecified";

  const contextPatterns = [
    /\b(?:when|while)\s+I\s+([^.!?,;\n]{6,80})/i,
    /\bduring\s+([^.!?,;\n]{6,80})/i,
    /\bon\s+the\s+([^.!?,;\n]{6,60})/i,
    /\bin\s+my\s+([^.!?,;\n]{6,60})/i,
  ];

  let movementContext = "";

  for (const pattern of contextPatterns) {
    const match = input.match(pattern);
    const candidate = match?.[1]?.trim();

    if (candidate) {
      movementContext = candidate.replace(/\s+/g, " ");
      break;
    }
  }

  if (!movementContext && detectedActivity !== "unspecified") {
    movementContext = detectedActivity;
  }

  if (!movementContext) {
    movementContext = "general movement";
  }

  return {
    movementContext: clampText(movementContext, 80),
    activityType: detectedActivity,
  };
}

// ==============================
// NAME EXTRACTION HELPERS
// ==============================

function extractConfidentExplicitName(text: string): string | null {
  const match = text.match(
    /\b(?:my name is|call me|i am|i'm|this is|it'?s)\s+([A-Za-z]{2,20})\b/i,
  );
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

async function getDominantRuntimePatternBlock(userId: string): Promise<string> {
  const recentCases = await db
    .select({
      id: cases.id,
      movementContext: cases.movementContext,
      activityType: cases.activityType,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
      status: cases.status,
    })
    .from(cases)
    .where(eq(cases.userId, userId))
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(6);

  if (recentCases.length === 0) return "";

  const candidates = await Promise.all(
    recentCases.map(async (caseRow) => {
      const signals = await db
        .select({
          id: caseSignals.id,
          description: caseSignals.description,
        })
        .from(caseSignals)
        .where(eq(caseSignals.caseId, caseRow.id))
        .orderBy(desc(caseSignals.id))
        .limit(3);

      const hypotheses = await db
        .select({
          id: caseHypotheses.id,
          hypothesis: caseHypotheses.hypothesis,
        })
        .from(caseHypotheses)
        .where(eq(caseHypotheses.caseId, caseRow.id))
        .orderBy(desc(caseHypotheses.id))
        .limit(2);

      const adjustments = await db
        .select({
          id: caseAdjustments.id,
          cue: caseAdjustments.cue,
          mechanicalFocus: caseAdjustments.mechanicalFocus,
        })
        .from(caseAdjustments)
        .where(eq(caseAdjustments.caseId, caseRow.id))
        .orderBy(desc(caseAdjustments.id))
        .limit(2);

      const outcomes = await db
        .select({
          id: caseOutcomes.id,
          result: caseOutcomes.result,
          userFeedback: caseOutcomes.userFeedback,
        })
        .from(caseOutcomes)
        .where(eq(caseOutcomes.caseId, caseRow.id))
        .orderBy(desc(caseOutcomes.id))
        .limit(3);

      const signalCount = signals.length;
      const hypothesisCount = hypotheses.length;
      const adjustmentCount = adjustments.length;
      const outcomeCount = outcomes.length;

      const improvedOutcomes = outcomes.filter((o) => {
        const resultText = String(o.result ?? "").trim();
        const feedbackText = String(o.userFeedback ?? "").trim();
        return /improved|better|resolved|clearer|easier|smoother|less/i.test(
          `${resultText} ${feedbackText}`,
        );
      }).length;

      const openCaseBoost =
        caseRow.status == null ||
        /open|active|current/i.test(String(caseRow.status))
          ? 4
          : 0;

      const score =
        signalCount * 1 +
        hypothesisCount * 3 +
        adjustmentCount * 3 +
        outcomeCount * 6 +
        improvedOutcomes * 4 +
        openCaseBoost;

      return {
        caseId: caseRow.id,
        movementContext: (caseRow.movementContext ?? "").trim(),
        activityType: (caseRow.activityType ?? "").trim(),
        score,
        signals,
        hypotheses,
        adjustments,
        outcomes,
      };
    }),
  );

  const ranked = candidates
    .filter(
      (c) =>
        c.movementContext ||
        c.activityType ||
        c.signals.length > 0 ||
        c.hypotheses.length > 0 ||
        c.adjustments.length > 0 ||
        c.outcomes.length > 0,
    )
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.caseId - a.caseId;
    });

  if (ranked.length === 0) return "";

  const dominant = ranked[0];
  const runnerUp = ranked[1];

  const dominantHypothesis = dominant.hypotheses[0]?.hypothesis?.trim() ?? "";
  const runnerUpHypothesis = runnerUp?.hypotheses[0]?.hypothesis?.trim() ?? "";

  const strongConflict =
    Boolean(runnerUp) &&
    runnerUp.score >= Math.max(8, Math.floor(dominant.score * 0.9)) &&
    dominantHypothesis &&
    runnerUpHypothesis &&
    dominantHypothesis.toLowerCase() !== runnerUpHypothesis.toLowerCase();

  const contextParts = [dominant.activityType, dominant.movementContext].filter(
    Boolean,
  );

  const recurringIssue = dominant.signals[0]?.description?.trim() ?? "";

  const helpfulAdjustment =
    dominant.adjustments
      .map((a) =>
        [a.cue?.trim(), a.mechanicalFocus?.trim()].filter(Boolean).join(" — "),
      )
      .filter(Boolean)[0] ?? "";

  const improvementEvidence =
    dominant.outcomes
      .map((o) =>
        [String(o.result ?? "").trim(), String(o.userFeedback ?? "").trim()]
          .filter(Boolean)
          .join(": "),
      )
      .filter(Boolean)[0] ?? "";

  const mechanismLine = dominantHypothesis ? `${dominantHypothesis}.` : "";

  const contextLine =
    contextParts.length > 0
      ? `This has been showing up around ${contextParts.join(" / ")}.`
      : "";

  const issueLine = recurringIssue
    ? `The recurring issue has been ${recurringIssue}.`
    : "";

  const adjustmentLine = helpfulAdjustment
    ? `What has helped most so far is ${helpfulAdjustment}.`
    : "";

  const outcomeLine = improvementEvidence
    ? `That produced ${improvementEvidence}.`
    : "";

  const continuationLine = strongConflict
    ? `Stay with this line if the current message fits it, but shift only if the new evidence clearly points elsewhere.`
    : `If the current message fits this same line, continue it instead of restarting. Only move away if it clearly no longer holds.`;

  return [
    contextLine,
    issueLine,
    mechanismLine,
    adjustmentLine,
    outcomeLine,
    continuationLine,
  ]
    .filter(Boolean)
    .join(" ");
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

        console.log("NAME DEBUG:", {
          userId,
          rawFirstName: existingUser?.firstName,
          normalizedFirstName: dbFirstName,
        });

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

        const lastAssistantMessage =
          [...previous].reverse().find((m) => m.role === "assistant") ?? null;

        const previousAssistantAskedName = Boolean(
          lastAssistantMessage &&
            askedWhatShouldICallYou(String(lastAssistantMessage.content ?? "")),
        );

        let storedFirstName = dbFirstName;
        const explicitName = storedFirstName
          ? null
          : extractConfidentExplicitName(userText);
        const standaloneNameReply =
          !storedFirstName && previousAssistantAskedName
            ? extractStandaloneNameReply(userText)
            : null;

        let capturedName: string | null = null;

        if (!storedFirstName && explicitName) {
          capturedName = explicitName;
        } else if (!storedFirstName && standaloneNameReply) {
          capturedName = standaloneNameReply;
        }

        if (!storedFirstName) {
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

          if (!capturedName) {
            const onboardingPrompt =
              "Hi, I’m Interloop. Before we begin, what should I call you?";

            res.setHeader("Content-Type", "text/event-stream");

            const words = onboardingPrompt.split(" ");

            for (const word of words) {
              res.write(`data: ${JSON.stringify({ content: word + " " })}\n\n`);
            }

            await db.insert(messages).values({
              conversationId: convoId,
              userId: userId,
              role: "assistant",
              content: onboardingPrompt,
            });

            res.write(`data: [DONE]\n\n`);
            res.end();
            return;
          }

          await db
            .update(users)
            .set({ firstName: capturedName })
            .where(eq(users.id, userId));

          storedFirstName = capturedName;
          const onboardingMessage = `
          Hi, I’m Interloop.

          I help figure out what’s actually driving what you’re experiencing in your body by breaking it down to the underlying mechanism, not just the surface symptom.

          Everything you describe is treated as signal — movement, tension, pain, timing, coordination, anything that changes. From there, I narrow it down to one thing that matters and we test it together.

          You don’t need to organize it perfectly. It’s fine if it’s messy or if you ramble. Just describe what’s happening as you experience it, and I’ll sort through it.

          Let’s begin.
          `;
          res.setHeader("Content-Type", "text/event-stream");

          const words = onboardingMessage.split(" ");

          for (const word of words) {
            res.write(`data: ${JSON.stringify({ content: word + " " })}\n\n`);
          }

          await db.insert(messages).values({
            conversationId: convoId,
            userId: userId,
            role: "assistant",
            content: onboardingMessage,
          });

          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
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

        try {
          const shouldCreateCase =
            !isCaseReview &&
            qualifiesForTimelineSignal(userText) &&
            !isPureOutcomeFollowUp(userText);

          if (shouldCreateCase) {
            const derivedCaseContext = deriveCaseContext(userText);
            const recentUserCases = await db
              .select({
                id: cases.id,
                conversationId: cases.conversationId,
                movementContext: cases.movementContext,
                activityType: cases.activityType,
                status: cases.status,
                createdAt: cases.createdAt,
                updatedAt: cases.updatedAt,
              })
              .from(cases)
              .where(eq(cases.userId, userId))
              .orderBy(desc(cases.updatedAt), desc(cases.id))
              .limit(12);

            const openCases = recentUserCases.filter((row) => {
              if (row.status == null) return true;
              return /open|active|current/i.test(String(row.status));
            });

            const derivedMovementKey = normalizeCaseKey(
              derivedCaseContext.movementContext,
            );
            const derivedActivityKey = normalizeCaseKey(
              derivedCaseContext.activityType,
            );

            const hasMaterialOpenCaseMatch = openCases.some((row) => {
              const rowMovementKey = normalizeCaseKey(row.movementContext);
              const rowActivityKey = normalizeCaseKey(row.activityType);

              const movementMatches =
                !isFallbackMovementContext(
                  derivedCaseContext.movementContext,
                ) &&
                !isFallbackMovementContext(row.movementContext) &&
                derivedMovementKey === rowMovementKey;

              const activityMatches =
                !isFallbackActivityType(derivedCaseContext.activityType) &&
                !isFallbackActivityType(row.activityType) &&
                derivedActivityKey === rowActivityKey;

              return movementMatches && activityMatches;
            });

            if (!hasMaterialOpenCaseMatch) {
              const [newCase] = await db
                .insert(cases)
                .values({
                  userId,
                  conversationId: convoId,
                  movementContext: derivedCaseContext.movementContext,
                  activityType: derivedCaseContext.activityType,
                  status: "open",
                })
                .returning();

              if (newCase) {
                await db.insert(caseSignals).values({
                  userId,
                  caseId: newCase.id,
                  description: clampText(userText, 800),
                });
              }
            }
          }
        } catch (err) {
          console.error("Case creation failed:", err);
        }

        const memory = await getMemory(userId);
        const memoryBlock = buildMemoryPromptBlock(memory);

        const storedSessionHistory = await getStoredSessionHistory(
          userId,
          convoId,
        );

        const activeHypothesisBlock = await getActiveHypothesisBlock(userId);
        const runtimePatternBlock =
          await getDominantRuntimePatternBlock(userId);

        let identityBlock = "";

        if (storedFirstName) {
          identityBlock = `=== USER IDENTITY ===
User's first name is ${storedFirstName}.

Name usage rules:

* The name is optional and should not be used in every response
* Use it only when it adds emphasis, clarity, or weight to a key point
* Do not default to placing the name at the beginning of the response
* Do not default to placing the name in the final sentence
* Do not attach the name to the final question by default
* Do not use the name as conversational filler
* Prefer not using the name over using it without purpose
* The name must feel natural and context-driven, not patterned`;
        } else {
          identityBlock = `=== USER IDENTITY ===
The user's first name is unknown.

Identity authority rule:
- Only the users table name field can authorize name usage
- Do not infer, recover, or use a name from memory, stored session history, prior messages, summaries, or any other injected context
- If a name appears elsewhere in context, treat it as non-authoritative and ignore it for identity usage`;
        }

        const ACTIVE_PROMPT = isCaseReview
          ? CASE_REVIEW_NARRATIVE
          : ACTIVE_BASE_NARRATIVE;

        console.log("CHAT STAGE: prompt-assembly");

        const patternPriorityBlock = !isCaseReview
          ? `
=== PATTERN PRIORITY RULE ===

If the current user message overlaps with an active pattern or recurring theme from memory:

- continue the existing mechanism
- do not introduce a new root cause unless the prior one clearly fails
- do not restart analysis from zero
- treat the new symptom as a variation, extension, or stress-test of the same underlying pattern
- move the investigation forward instead of re-explaining the whole theory
- avoid hedging when pattern continuity is already established

If multiple details are present, prioritize the dominant recurring pattern already in memory over novel interpretation.
`
          : "";

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

${runtimePatternBlock}

${patternPriorityBlock}

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
        let finalText = assistantText;

        if (!isCaseReview) {
          const isWeak =
            /could be|might be|possibly|several|a few things/i.test(
              assistantText,
            );

          const isGenericSuccess =
            /glad to hear|great to hear|happy to hear|keep it up|let me know|feel free to reach out/i.test(
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
            isGenericSuccess ||
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
That response drifted from the active narrative. Rewrite it so the execution stays faithful to the base narrative and the Interloop response arc.

Required response behavior:
- Keep one dominant mechanism only
- Do not reopen multiple explanations or branches
- Start by validating only what is actually correct, then immediately correct the user's misunderstanding in natural language
- Correct the user's misunderstanding directly, without labeling it or naming it
- If the user reports improvement or success, begin with brief earned validation, then immediately explain what the improvement confirms mechanically
- When success is reported, identify the next likely breakdown, overcorrection, or relapse point instead of drifting into praise or closure
- Identify the single most important error, misread, or drift point
- Correct that point directly and decisively
- Use contrast when useful (not X, Y)
- Compress the correction into one clear idea, expressed naturally inside the explanation
- Tie the correction to the user's known pattern/history when relevant
- Predict the most likely next overcorrection, compensation, failure, or relapse point
- Give one tight execution model, not multiple options
- Give one immediate real-world check for whether it is correct
- End with exactly one diagnostic question that matches the current state: if the mechanism is not yet proven, ask a deeper investigative question that narrows the breakdown; if the user has reported improvement or success, ask a binary stress-test question that checks whether the mechanism holds under variation
- When the user reports that something worked, translate the success into mechanism confirmation, not encouragement
- Do not treat initial success as resolution; treat it as confirmation and immediately test the mechanism under variation (speed, load, fatigue, or context change)
- If success has been reported, make the next question diagnostic and focused on whether the mechanism holds under increased demand or different conditions
- Before success is confirmed, do not ask a binary closure question; ask a narrower investigative question that helps locate the actual breakdown in timing, sequence, load transfer, or compensation
- Avoid repeating the same key terms across responses (such as "pattern", "coordination", "adjustment", "alignment")
- Vary wording naturally when describing similar ideas
- Do not rely on a fixed vocabulary to explain similar situations
- The same concept should be expressed in different ways across responses
- Prefer natural phrasing over consistent terminology
- It is acceptable to use these terms occasionally when they are the clearest way to describe something
- However, they must not become the default or repeated structure of explanation

Hard rules:
- Do not hedge when pattern continuity is already established
- Do not use bolded headers, titled sections, bullets, or packaged formatting
- Do not sound generic, therapeutic, motivational, or like a normal assistant
- Do not restate the whole problem from scratch
- Do not explain broadly when a precise correction is available
- The response should feel slightly corrective and willing to challenge the user's framing when needed
- The response must read as one continuous explanation with natural paragraphing
- Avoid repeated phrases like "the incorrect assumption is" or "most likely overcorrection"; vary phrasing naturally
- Prefer direct, natural correction language instead of formal or scripted phrasing
- Make the governing rule short and punchy, not descriptive
- Make the final question specific and mechanically useful: before success, it should deepen the investigation; after success, it should test hold-or-break under variation
- Do not force name usage
- Use the name only when it adds meaning or emphasis
- Do not use the name more than once unless absolutely necessary
- Do not place the name consistently at the start of responses
- Do not place the name consistently at the end of responses
- Do not attach the name to the final question by default
- The name must not follow a repeated positional pattern
- Prefer omitting the name over using it habitually
- Do not let success-state responses collapse into praise, reassurance, or generic encouragement
- Do not end a success-state response with "keep it up", "let me know", or other assistant-style closure

Preserve what is already working in the draft:
- keep the paragraph flow
- keep the sense of continuity
- keep the mechanism-first feel

Produce the corrected response now.
                `.trim(),
              },
            ];

            finalText = await runCompletion(openai, retryMessages);
          }
        }

        res.setHeader("Content-Type", "text/event-stream");

        const words = finalText.split(" ");

        for (const word of words) {
          res.write(`data: ${JSON.stringify({ content: word + " " })}\n\n`);
        }

        console.log("CHAT STAGE: assistant-message-insert");

        await db.insert(messages).values({
          conversationId: convoId,
          userId: userId,
          role: "assistant",
          content: finalText,
        });

        try {
          console.log("CASE REVIEW WRITE CHECK:", {
            isCaseReview,
            assistantLength: finalText.length,
            userId,
          });

          if (isCaseReview && finalText.length > 60) {
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
                reviewText: finalText,
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
          const shouldWriteTimeline = qualifiesForTimelineSignal(userText);

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

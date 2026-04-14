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
  caseReviews,
} from "@shared/schema";

import {
  getMemory,
  updateMemory,
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

const INTERLOOP_SETTINGS_VOICE_IDS = {
  female_pilates: "VI2qcJpxMy5M6WFvpIrh",
  female_yoga: "RjWJXbF7h9KPSuGnLo5x",
  male_coach: "GwiNi5XZx3ydWAkkDpoQ",
  male_pt: "3WZjQ5NUrKH37Zw6Vgp7",
} as const;

type PersistedInterloopVoice = keyof typeof INTERLOOP_SETTINGS_VOICE_IDS;

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

type PersistedInterloopSettings = {
  name: string;
  age: string;
  height: string;
  weight: string;
  primaryActivity: string;
  dominantHand: string;
  activityLevel: string;
  competitionLevel: string;
  voice: PersistedInterloopVoice;
  completed: boolean;
};

function normalizeSettingsText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSettingsVoice(value: unknown): PersistedInterloopVoice {
  if (typeof value === "string" && value in INTERLOOP_SETTINGS_VOICE_IDS) {
    return value as PersistedInterloopVoice;
  }

  return "male_coach";
}

function normalizeCompletedFlag(value: unknown): boolean {
  return value === true;
}

function normalizeAgeForMemory(value: unknown): number | null {
  const normalized = normalizeSettingsText(value);
  if (!normalized) return null;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;

  return parsed;
}

function buildPersistedSettings(
  firstName: unknown,
  memory: Awaited<ReturnType<typeof getMemory>>,
): PersistedInterloopSettings {
  const memoryWithPreferences = memory as typeof memory & {
    preferences?: {
      voice?: unknown;
      activityLevel?: unknown;
      setupCompleted?: unknown;
    };
  };

  return {
    name: normalizeStoredFirstName(firstName) ?? "",
    age:
      typeof memory.identity.age === "number" &&
      Number.isFinite(memory.identity.age)
        ? String(memory.identity.age)
        : "",
    height: normalizeSettingsText(memory.identity.height),
    weight: normalizeSettingsText(memory.identity.weight),
    primaryActivity: normalizeSettingsText(memory.sportContext.primarySport),
    dominantHand: normalizeSettingsText(memory.identity.dominantHand),
    activityLevel: normalizeSettingsText(
      memoryWithPreferences.preferences?.activityLevel,
    ),
    competitionLevel: normalizeSettingsText(
      memory.sportContext.competitionLevel,
    ),
    voice: normalizeSettingsVoice(memoryWithPreferences.preferences?.voice),
    completed: normalizeCompletedFlag(
      memoryWithPreferences.preferences?.setupCompleted,
    ),
  };
}

async function ensureUserRecord(userId: string, authUser: any) {
  let [existingUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

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

    [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
  }

  return existingUser;
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

function buildCompactMovementContext(text: string): string | null {
  const input = text.trim();

  const directContextPatterns: Array<{ label: string; regex: RegExp }> = [
    {
      label: "drive serve",
      regex: /\bdrive[-\s]?(?:serve|serf|surf)\b/i,
    },
    { label: "serve swing", regex: /\bserve[-\s]?swing\b/i },
    { label: "backswing", regex: /\bback[-\s]?swing\b/i },
    { label: "forehand swing", regex: /\b(?:forehand|forhand)\b/i },
    { label: "backhand swing", regex: /\bback[-\s]?hand\b/i },
    { label: "contact point", regex: /\bcontact point\b/i },
    {
      label: "toss out in front",
      regex:
        /\btoss\b.*\bout in front\b|\bthrow(?:ing)? the ball out in front\b/i,
    },
    {
      label: "serve lean forward",
      regex:
        /\bleaning forward\b.*\b(?:serve|serf|surf)\b|\b(?:serve|serf|surf)\b.*\bleaning forward\b/i,
    },
    { label: "serve", regex: /\b(?:serve|serving)\b/i },
    { label: "swing", regex: /\bswing(?:ing)?\b/i },
  ];

  return (
    directContextPatterns.find((pattern) => pattern.regex.test(input))?.label ??
    null
  );
}

function deriveCaseContext(text: string): {
  movementContext: string;
  activityType: string;
} {
  const input = text.trim();
  const normalizedInput = normalizeCaseKey(input);
  const isRacquetballContext =
    /\bracquetball\b|\bdrive[-\s]?(?:serve|serf|surf)\b|\bserve[-\s]?swing\b|\bback[-\s]?swing\b|\b(?:forehand|forhand)\b|\bback[-\s]?hand\b|\bcontact point\b/i.test(
      input,
    ) ||
    (/\btoss\b/i.test(input) &&
      /\bout in front\b|\bthrow(?:ing)? the ball out in front\b/i.test(input));

  const activityPatterns: Array<{ label: string; regex: RegExp }> = [
    {
      label: "racquetball",
      regex:
        /\bracquetball\b|\bdrive[-\s]?(?:serve|serf|surf)\b|\bserve[-\s]?swing\b|\bback[-\s]?swing\b|\b(?:forehand|forhand)\b|\bback[-\s]?hand\b|\bcontact point\b/i,
    },
    { label: "running", regex: /\brun(?:ning)?\b/i },
    { label: "walking", regex: /\bwalk(?:ing)?\b/i },
    { label: "squat", regex: /\bsquat(?:ting)?\b/i },
    { label: "deadlift", regex: /\bdeadlift(?:ing)?\b/i },
    { label: "lunge", regex: /\blunge(?:s|ing)?\b/i },
    { label: "serve", regex: /\bserve\b|\bserving\b/i },
    { label: "swing", regex: /\bswing\b|\bswinging\b/i },
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
  movementContext = buildCompactMovementContext(input) ?? "";

  if (!movementContext) {
    const serveMatch = input.match(
      /\b(?:my|the)?\s*(drive[-\s]?(?:serve|serf|surf)|serve[-\s]?swing|serve|back[-\s]?swing|(?:forehand|forhand)|back[-\s]?hand|contact point)\b/i,
    );
    if (serveMatch?.[1]) {
      movementContext = buildCompactMovementContext(serveMatch[1]) ?? "";
    }
  }

  for (const pattern of contextPatterns) {
    if (movementContext) break;

    const match = input.match(pattern);
    const candidate = match?.[1]?.trim();

    if (candidate) {
      movementContext = candidate.replace(/\s+/g, " ");
      break;
    }
  }

  if (
    !movementContext &&
    /\btoss\b/i.test(input) &&
    /\bout in front\b|\bthrow(?:ing)? the ball out in front\b/i.test(input)
  ) {
    movementContext = "toss out in front";
  }

  if (isRacquetballContext) {
    return {
      movementContext: clampText(movementContext || "serve mechanics", 80),
      activityType: "racquetball",
    };
  }

  if (!movementContext && detectedActivity !== "unspecified") {
    movementContext = detectedActivity;
  }

  if (
    !movementContext &&
    normalizedInput.includes("leaning forward") &&
    (normalizedInput.includes("serve") || detectedActivity === "racquetball")
  ) {
    movementContext = "serve lean forward";
  }

  if (!movementContext) {
    movementContext = "general movement";
  }

  return {
    movementContext: clampText(movementContext, 80),
    activityType: detectedActivity,
  };
}

function deriveBodyRegion(text: string): string | null {
  const input = text.trim();

  const regionPatterns: Array<{ label: string; regex: RegExp }> = [
    { label: "low back", regex: /\blow back\b|\blower back\b|\blumbar\b/i },
    {
      label: "mid back",
      regex: /\bmid back\b|\bmiddle back\b|\bthoracic\b/i,
    },
    { label: "back", regex: /\bback\b/i },
    { label: "shoulder", regex: /\bshoulder\b|\bdeltoid\b/i },
    { label: "knee", regex: /\bknee\b/i },
    { label: "ankle", regex: /\bankle\b/i },
    { label: "hip", regex: /\bhip\b|\bglute\b|\bgluteal\b/i },
    { label: "elbow", regex: /\belbow\b/i },
    { label: "wrist", regex: /\bwrist\b/i },
    { label: "neck", regex: /\bneck\b|\bcervical\b/i },
    { label: "foot", regex: /\bfoot\b|\bfeet\b/i },
    {
      label: "leg",
      regex: /\bleg\b|\bquad\b|\bhamstring\b|\bcalf\b|\bshin\b/i,
    },
    { label: "arm", regex: /\barm\b|\bbiceps?\b|\btriceps?\b|\bforearm\b/i },
  ];

  return regionPatterns.find((entry) => entry.regex.test(input))?.label ?? null;
}

function deriveSignalType(text: string): string | null {
  const input = text.trim();

  const signalPatterns: Array<{ label: string; regex: RegExp }> = [
    {
      label: "instability",
      regex:
        /\bunstable\b|\binstability\b|\bnot stable\b|\bgiving out\b|\bwobbly\b/i,
    },
    {
      label: "timing",
      regex:
        /\btiming\b|\boff timing\b|\bout of sync\b|\btoo early\b|\btoo late\b/i,
    },
    {
      label: "coordination",
      regex:
        /\bcoordination\b|\bcoordinated\b|\bawkward\b|\bmechanics feel wrong\b|\bmovement is weird\b/i,
    },
    {
      label: "weakness",
      regex: /\bweak\b|\bweakness\b|\bcan'?t generate force\b|\bno power\b/i,
    },
    {
      label: "limitation",
      regex:
        /\bcan'?t\b|\bcannot\b|\blimited\b|\blimitation\b|\brestricted\b|\bdoesn'?t let me\b/i,
    },
    {
      label: "tightness",
      regex: /\btight\b|\btightness\b|\bstiff\b|\bstiffness\b|\btension\b/i,
    },
    {
      label: "pain",
      regex:
        /\bpain\b|\bpainful\b|\bhurt\b|\bhurts\b|\bhurting\b|\bsore\b|\bsoreness\b|\bache\b|\baching\b/i,
    },
    {
      label: "discomfort",
      regex: /\bdiscomfort\b|\buncomfortable\b|\birritated\b|\bannoying\b/i,
    },
  ];

  return signalPatterns.find((entry) => entry.regex.test(input))?.label ?? null;
}

function normalizeOptionalLabel(value: string | null | undefined): string {
  return normalizeCaseKey(value);
}

function hasStrongCaseContext(value: string | null | undefined): boolean {
  return (
    !isFallbackMovementContext(value) && normalizeOptionalLabel(value) !== ""
  );
}

function hasStrongCaseActivity(value: string | null | undefined): boolean {
  return !isFallbackActivityType(value) && normalizeOptionalLabel(value) !== "";
}

type ProfileFieldKey =
  | "primary_sport"
  | "dominant_hand"
  | "competition_level"
  | "activity_level"
  | "age"
  | "height"
  | "weight"
  | "gender";

function hasAgeProfileContext(text: string): boolean {
  return /\b(?:i am|i'm)\s+\d{1,2}\b|\b\d{1,2}\s*(?:years?\s*old|yo)\b/i.test(
    text.trim(),
  );
}

function hasGenderProfileContext(text: string): boolean {
  return /\b(?:i am|i'm)\s+(?:male|female|a man|a woman|nonbinary|non-binary)\b|\bmy sex is\s+(?:male|female)\b|\bi identify as\s+(?:male|female|a man|a woman|nonbinary|non-binary)\b/i.test(
    text.trim(),
  );
}

function hasHeightProfileContext(text: string): boolean {
  return /\b\d\s*'\s*\d{1,2}(?:\"|”)?\b|\b\d\s*(?:ft|feet)\s*\d{1,2}\b|\b\d{2,3}\s*cm\b|\b1\.\d{1,2}\s*m\b/i.test(
    text.trim(),
  );
}

function hasWeightProfileContext(text: string): boolean {
  return /\b\d{2,3}\s*(?:lb|lbs|pounds|kg|kgs)\b/i.test(text.trim());
}

function hasPrimarySportProfileContext(text: string): boolean {
  return /\b(?:my|the)\s+(?:main|primary)\s+(?:sport|activity)\s+is\s+[a-z][a-z\s-]{2,30}\b|\bi\s+(?:mainly|mostly|primarily)\s+(?:play|do|train|compete in)\s+[a-z][a-z\s-]{2,30}\b|\bi'm\s+(?:a|an)\s+[a-z][a-z\s-]{2,30}\s+(?:player|athlete)\b/i.test(
    text.trim(),
  );
}

function hasActivityLevelProfileContext(text: string): boolean {
  return /\b(?:sedentary|lightly active|active|very active|train(?:ing)?\s+\d+\s*(?:x|times?)\s+(?:a\s+)?week|work out|workout|lift\s+\d+\s*(?:x|times?)|practice\s+\d+\s*(?:x|times?)|play\s+\d+\s*(?:x|times?))\b/i.test(
    text.trim(),
  );
}

function hasCompetitionLevelProfileContext(text: string): boolean {
  return /\b(?:recreational|rec league|club|intramural|varsity|high school|college|collegiate|semi[-\s]?pro|professional|compete|competition|tournament)\b/i.test(
    text.trim(),
  );
}

function hasDominantHandProfileContext(text: string): boolean {
  return /\b(?:right[-\s]?handed|left[-\s]?handed|dominant hand|throw right|throw left|bat right|bat left)\b/i.test(
    text.trim(),
  );
}

function isStrongLiveInvestigationTurn(
  currentUserText: string,
  recentMessages: Array<{ role: string; content: string }>,
): boolean {
  const input = currentUserText.trim();
  if (!input) return false;

  const previousAssistantText =
    [...recentMessages]
      .reverse()
      .find((m) => m.role === "assistant" && String(m.content ?? "").trim())
      ?.content ?? "";

  const strongCurrentTurnSignal =
    qualifiesForTimelineSignal(input) ||
    looksLikeAdjustment(input) ||
    looksLikeOutcome(input) ||
    detectOutcomeResult(input) != null ||
    deriveBodyRegion(input) != null ||
    !isFallbackMovementContext(deriveCaseContext(input).movementContext) ||
    /\b(?:timing|rotation|rotate|load|pressure|mechanic|mechanics|sequence|shift|brace|hinge|backswing|forehand|backhand|contact point|stability|stable|unstable|compensation|compensating|breakdown|fatigue|under load|at speed)\b/i.test(
      input,
    );

  if (strongCurrentTurnSignal) {
    return true;
  }

  const borderlineCurrentTurnSignal =
    /\b(?:when|while|during|every time|serve|swing|movement|feels off|awkward|not right|doesn't feel right|doesnt feel right|something is off)\b/i.test(
      input,
    );

  const assistantWasInvestigating =
    /\?\s*$/.test(String(previousAssistantText).trim()) ||
    /\b(?:what happens|where exactly|does it show up|when does it happen|under load|at speed|under fatigue|on the backswing|on the serve|at contact|what changes when|does it hold if)\b/i.test(
      String(previousAssistantText),
    );

  return borderlineCurrentTurnSignal && assistantWasInvestigating;
}

function detectRecentUnansweredProfileAsk(
  recentMessages: Array<{ role: string; content: string }>,
): ProfileFieldKey | null {
  const recentAssistantMessages = recentMessages
    .filter((m) => m.role === "assistant")
    .slice(-4)
    .map((m) => String(m.content ?? ""));

  const recentUserMessages = recentMessages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => String(m.content ?? ""));

  const checks: Array<{
    key: ProfileFieldKey;
    patterns: RegExp[];
    answered: (text: string) => boolean;
  }> = [
    {
      key: "primary_sport",
      patterns: [
        /\bwhat activity is this showing up in most\b/i,
        /\bwhat sport are you mainly playing(?: right now)?\b/i,
        /\bwhat do you spend most of your time doing physically\b/i,
        /\bwhat are you mainly (?:playing|training|doing)\b/i,
        /\bwhat'?s your main (?:sport|activity)\b/i,
      ],
      answered: hasPrimarySportProfileContext,
    },
    {
      key: "dominant_hand",
      patterns: [
        /\bwhich side do you naturally lead with\b/i,
        /\bare you right[-\s]?handed or left[-\s]?handed\b/i,
        /\bwhat'?s your dominant (?:side|hand)\b/i,
        /\bwhich hand is dominant for you\b/i,
      ],
      answered: hasDominantHandProfileContext,
    },
    {
      key: "competition_level",
      patterns: [
        /\bis that more recreational or are you competing seriously\b/i,
        /\bhow competitive is that for you\b/i,
        /\bwhat level are you playing at\b/i,
        /\bare you competing or mostly recreational\b/i,
        /\bis this more rec or more competitive for you\b/i,
      ],
      answered: hasCompetitionLevelProfileContext,
    },
    {
      key: "activity_level",
      patterns: [
        /\bhow often are you doing it right now\b/i,
        /\bhow many days a week are you training\b/i,
        /\bwhat does your week look like physically\b/i,
        /\bhow active are you right now\b/i,
        /\bhow much are you training these days\b/i,
      ],
      answered: hasActivityLevelProfileContext,
    },
    {
      key: "age",
      patterns: [/\bhow old are you\b/i, /\bwhat'?s your age\b/i],
      answered: hasAgeProfileContext,
    },
    {
      key: "height",
      patterns: [/\bhow tall are you\b/i, /\bwhat'?s your height\b/i],
      answered: hasHeightProfileContext,
    },
    {
      key: "weight",
      patterns: [
        /\bwhat do you weigh right now\b/i,
        /\broughly what do you weigh\b/i,
        /\bwhat'?s your current weight\b/i,
      ],
      answered: hasWeightProfileContext,
    },
    {
      key: "gender",
      patterns: [
        /\bare you male or female\b/i,
        /\bhow do you want me to think about sex differences here\b/i,
        /\bshould i think about this through a male or female lens\b/i,
        /\bhow do you identify\b/i,
      ],
      answered: hasGenderProfileContext,
    },
  ];

  for (const check of checks) {
    const askedRecently = recentAssistantMessages.some((text) =>
      check.patterns.some((pattern) => pattern.test(text)),
    );
    const answeredRecently = recentUserMessages.some((text) =>
      check.answered(text),
    );

    if (askedRecently && !answeredRecently) {
      return check.key;
    }
  }

  return null;
}

function isOpenCaseStatus(status: string | null | undefined): boolean {
  if (status == null) return true;
  return /open|active|current/i.test(String(status));
}

async function getConversationOpenCase(
  userId: string,
  conversationId: number,
): Promise<{
  id: number;
  userId: string;
  conversationId: number | null;
  movementContext: string | null;
  activityType: string | null;
  status: string | null;
} | null> {
  const [conversationOpenCase] = await db
    .select({
      id: cases.id,
      userId: cases.userId,
      conversationId: cases.conversationId,
      movementContext: cases.movementContext,
      activityType: cases.activityType,
      status: cases.status,
    })
    .from(cases)
    .where(
      and(eq(cases.userId, userId), eq(cases.conversationId, conversationId)),
    )
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(1);

  if (!conversationOpenCase || !isOpenCaseStatus(conversationOpenCase.status)) {
    return null;
  }

  return conversationOpenCase;
}

function extractFirstMatchingSentence(
  text: string,
  patterns: RegExp[],
): string | null {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const candidates = sentences
    .map((sentence) => {
      const normalized = sentence
        .replace(/[*_`#>\[\]()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const wordCount = normalized.split(" ").filter(Boolean).length;
      const patternMatches = patterns.filter((pattern) =>
        pattern.test(normalized),
      ).length;

      if (!normalized) return null;
      if (normalized.length < 35) return null;
      if (wordCount < 6) return null;
      if (!/[.!?]$/.test(sentence)) return null;
      if (/^[A-Z][A-Z\s]+:?$/.test(normalized)) return null;
      if (isLowSignalShiftText(normalized)) return null;
      if (isGenericCoachingFillerText(normalized)) return null;
      if (patternMatches === 0) return null;

      let score = patternMatches * 5;
      if (isStrongHypothesisCandidate(normalized)) score += 12;
      if (isStrongAdjustmentCandidate(normalized)) score += 12;
      if (isMechanismLikeText(normalized)) score += 5;
      if (isTestLikeText(normalized)) score += 5;
      if (
        /\b(?:because|due to|driven by|caused by|points to)\b/i.test(normalized)
      ) {
        score += 4;
      }
      if (
        /^(?:focus on|try|make sure|keep|let|allow|shift|think about)\b/i.test(
          normalized,
        )
      ) {
        score += 4;
      }
      if (normalized.length >= 55) score += 2;
      if (normalized.length > 240) score -= 3;

      return {
        sentence: clampText(sentence, 400),
        score,
      };
    })
    .filter((candidate): candidate is { sentence: string; score: number } =>
      Boolean(candidate),
    )
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.sentence ?? null;
}

function extractBestHypothesisSentence(text: string): string | null {
  const hypothesisPatterns: RegExp[] = [
    /\bbecause\b/i,
    /\bdue to\b/i,
    /\bdriven by\b/i,
    /\bcaused by\b/i,
    /\bcomes from\b/i,
    /\bis coming from\b/i,
    /\bhappening because\b/i,
    /\bthis is happening because\b/i,
    /\bthe issue is\b/i,
    /\bthe problem is\b/i,
    /\bwhat'?s going on is\b/i,
    /\bwhat'?s happening is\b/i,
    /\bthis comes from\b/i,
    /\bthis usually comes from\b/i,
    /\bthis is driven by\b/i,
    /\bis breaking\b/i,
    /\bis collapsing\b/i,
    /\bis stalling\b/i,
    /\bis opening too early\b/i,
    /\bis shifting too early\b/i,
    /\bis losing structure\b/i,
    /\bis unstable\b/i,
    /\bis dropping\b/i,
    /\bis not holding\b/i,
    /\bis over[-\s]?rotating\b/i,
    /\bis under[-\s]?loading\b/i,
    /\bis compensating\b/i,
    /\bis taking over\b/i,
    /\bis bearing the load\b/i,
    /\bis driving the issue\b/i,
    /\bbreaking before\b/i,
    /\bopening before\b/i,
    /\bshifting too early\b/i,
    /\bstalling under\b/i,
    /\bcollapsing under\b/i,
    /\blosing structure once\b/i,
    /\btrying to organize\b/i,
  ];

  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const candidates = sentences
    .map((sentence) => {
      const normalized = sentence
        .replace(/[*_`#>\[\]()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const wordCount = normalized.split(" ").filter(Boolean).length;
      const patternMatches = hypothesisPatterns.filter((pattern) =>
        pattern.test(normalized),
      ).length;

      if (!normalized) return null;
      if (normalized.length < 40) return null;
      if (normalized.length > 260) return null;
      if (wordCount < 7) return null;
      if (!/[.!?]$/.test(sentence)) return null;
      if (patternMatches === 0) return null;
      if (!isStrongHypothesisCandidate(normalized)) return null;

      let score = patternMatches * 6;
      if (hasExplanatoryMechanismLanguage(normalized)) score += 8;
      if (hasMechanismBreakdownLanguage(normalized)) score += 8;
      if (hasMechanismAnchor(normalized)) score += 6;
      if (normalized.length >= 55) score += 2;

      return {
        sentence: clampText(sentence, 400),
        score,
      };
    })
    .filter((candidate): candidate is { sentence: string; score: number } =>
      Boolean(candidate),
    )
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.sentence ?? null;
}

function extractBestAdjustmentSentence(text: string): string | null {
  const adjustmentPatterns: RegExp[] = [
    /^\s*focus on\b/i,
    /^\s*try\b/i,
    /^\s*make sure\b/i,
    /^\s*let\b/i,
    /^\s*allow\b/i,
    /^\s*shift\b/i,
    /^\s*keep\b/i,
    /^\s*think about\b/i,
    /^\s*load\b/i,
    /^\s*relax\b/i,
    /^\s*drive\b/i,
    /^\s*rotate\b/i,
    /^\s*brace\b/i,
    /^\s*stack\b/i,
    /^\s*press\b/i,
    /^\s*pull\b/i,
    /^\s*push\b/i,
    /^\s*hinge\b/i,
    /^\s*hold\b/i,
    /^\s*stay\b/i,
  ];

  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const candidates = sentences
    .map((sentence) => {
      const normalized = sentence
        .replace(/[*_`#>\[\]()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const wordCount = normalized.split(" ").filter(Boolean).length;
      const patternMatches = adjustmentPatterns.filter((pattern) =>
        pattern.test(normalized),
      ).length;

      if (!normalized) return null;
      if (normalized.length < 20) return null;
      if (normalized.length > 180) return null;
      if (wordCount < 4) return null;
      if (!/[.!?]$/.test(sentence)) return null;
      if (patternMatches === 0) return null;
      if (!isStrongAdjustmentCandidate(normalized)) return null;

      let score = patternMatches * 6;
      if (hasAdjustmentDirectiveStart(normalized)) score += 8;
      if (hasConcreteAdjustmentAnchor(normalized)) score += 8;
      if (!isClearlyBundledAdjustmentSequence(normalized)) score += 6;
      if (!hasDiagnosisLanguage(normalized)) score += 6;
      if (normalized.length >= 35 && normalized.length <= 110) score += 2;

      return {
        sentence: clampText(sentence, 300),
        score,
      };
    })
    .filter((candidate): candidate is { sentence: string; score: number } =>
      Boolean(candidate),
    )
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.sentence ?? null;
}

function normalizePreviewValue(
  value: string | null | undefined,
): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function extractPreviewSnippet(
  value: string | null | undefined,
  max = 180,
): string | null {
  const text = normalizePreviewValue(value);
  if (!text) return null;
  if (text.length < 35) return null;

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const meaningfulSentence =
    sentences.find((sentence) => {
      const normalized = sentence
        .replace(/[*_`#>\-\[\]()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (!normalized || normalized.length < 35) return false;
      if (/^[-–—\s]+$/.test(sentence)) return false;
      if (/^[A-Z][A-Z\s]+:?$/.test(normalized)) return false;

      const wordCount = normalized.split(" ").filter(Boolean).length;
      return wordCount >= 6;
    }) ?? text;

  const snippet = normalizePreviewValue(clampText(meaningfulSentence, max));
  if (!snippet || snippet.length < 35) return null;
  return snippet;
}

function normalizeDashboardCandidate(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[*_`#>\-\[\]()'",.:;!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMechanismLikeText(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  const explicitMechanismPatterns = [
    /\bbecause\b/i,
    /\bdue to\b/i,
    /\bdriven by\b/i,
    /\bcaused by\b/i,
    /\bcoming from\b/i,
    /\bhappening because\b/i,
    /\bpoints to\b/i,
    /\bwhat'?s happening\b/i,
    /\bthe issue is\b/i,
    /\bthe problem is\b/i,
  ];

  const declarativeMechanismPatterns = [
    /\bis breaking\b/i,
    /\bis collapsing\b/i,
    /\bis stalling\b/i,
    /\bis opening too early\b/i,
    /\bis shifting too early\b/i,
    /\bis losing structure\b/i,
    /\bis unstable\b/i,
    /\bis dropping\b/i,
    /\bis not holding\b/i,
    /\bis over[-\s]?rotating\b/i,
    /\bis under[-\s]?loading\b/i,
    /\bis compensating\b/i,
    /\bis taking over\b/i,
    /\bis bearing the load\b/i,
    /\bis driving the issue\b/i,
    /\bbreaking before\b/i,
    /\bopening before\b/i,
    /\bshifting too early\b/i,
    /\bstalling under\b/i,
    /\bcollapsing under\b/i,
    /\blosing structure once\b/i,
    /\btrying to organize\b/i,
  ];

  const instructionPatterns = [
    /^\s*focus on\b/i,
    /^\s*try\b/i,
    /^\s*make sure\b/i,
    /^\s*keep\b/i,
    /^\s*let\b/i,
    /^\s*allow\b/i,
    /^\s*shift\b/i,
    /^\s*think about\b/i,
    /^\s*the key is\b/i,
    /^\s*this exercise\b/i,
    /^\s*work on\b/i,
  ];

  const genericSuccessPatterns = [
    /\bthis is working\b/i,
    /\bworking well\b/i,
    /\baligning well\b/i,
    /\bthis is aligning\b/i,
    /\bgood sign\b/i,
    /\bthis should help\b/i,
    /\bthat should help\b/i,
    /\bkeep it up\b/i,
    /\bglad to hear\b/i,
  ];

  if (instructionPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (genericSuccessPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  return (
    explicitMechanismPatterns.some((pattern) => pattern.test(text)) ||
    declarativeMechanismPatterns.some((pattern) => pattern.test(text))
  );
}

function isTestLikeText(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  const concreteActionStartPatterns = [
    /^\s*focus on\b/i,
    /^\s*try\b/i,
    /^\s*make sure\b/i,
    /^\s*keep\b/i,
    /^\s*let\b/i,
    /^\s*allow\b/i,
    /^\s*shift\b/i,
    /^\s*think about\b/i,
    /^\s*load\b/i,
    /^\s*relax\b/i,
    /^\s*drive\b/i,
    /^\s*rotate\b/i,
    /^\s*brace\b/i,
    /^\s*stack\b/i,
    /^\s*press\b/i,
    /^\s*pull\b/i,
    /^\s*push\b/i,
    /^\s*hinge\b/i,
    /^\s*hold\b/i,
    /^\s*stay\b/i,
  ];

  const diagnosisPatterns = [
    /\bbecause\b/i,
    /\bdue to\b/i,
    /\bdriven by\b/i,
    /\bcaused by\b/i,
    /\bcoming from\b/i,
    /\bhappening because\b/i,
    /\bpoints to\b/i,
    /\bwhat'?s happening\b/i,
    /\bthe issue is\b/i,
    /\bthe problem is\b/i,
  ];

  const vagueAdvicePatterns = [
    /\bthe key is\b/i,
    /\bthis should help\b/i,
    /\bthat should help\b/i,
    /\bstay aware of\b/i,
    /\bbe aware of\b/i,
    /\bconsistency\b/i,
    /\bkeep working on\b/i,
  ];

  if (!concreteActionStartPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (diagnosisPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (vagueAdvicePatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  return /\b(?:hip|rib|pelvis|trunk|shoulder|shoulders|back|spine|brace|load|stack|rotate|hinge|foot|feet|ankle|knee|glute|serve|swing|contact|backswing|pressure|front leg|front side|transfer|release|structure)\b/i.test(
    text,
  );
}

function isGenericCoachingFillerText(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return true;

  const fillerPatterns = [
    /^\s*the key is\b/i,
    /^\s*this matters\b/i,
    /^\s*that matters\b/i,
    /^\s*it'?s important\b/i,
    /^\s*it is important\b/i,
    /^\s*that should help\b/i,
    /^\s*this should help\b/i,
    /^\s*stay aware of\b/i,
    /^\s*be aware of\b/i,
    /^\s*consistency\b/i,
    /^\s*this exercise\b/i,
    /\baligns with\b/i,
    /\bwhat you need\b/i,
    /\bthis is working\b/i,
    /\bworking well\b/i,
    /\baligning well\b/i,
    /\bthis is aligning\b/i,
    /\bgood sign\b/i,
    /\bglad to hear\b/i,
    /\bgreat to hear\b/i,
    /\bhappy to hear\b/i,
    /\bkeep it up\b/i,
    /\blet me know\b/i,
  ];

  return fillerPatterns.some((pattern) => pattern.test(text));
}

function hasExplanatoryMechanismLanguage(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  return /\b(?:because|due to|driven by|caused by|coming from|comes from|is coming from|happening because|the issue is|the problem is|what'?s happening is|what'?s going on is|this is happening because)\b/i.test(
    text,
  );
}

function hasMechanismBreakdownLanguage(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  return /\b(?:breaking|collapsing|opening too early|shifting too early|losing structure|compensating|taking over|bearing the load|bearing load|stalling under load|stalling under|dropping too early|not holding|under[-\s]?loading|over[-\s]?rotating|driving the issue|opening before|breaking before|collapsing under)\b/i.test(
    text,
  );
}

function hasMechanismAnchor(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  return /\b(?:hip|hips|trunk|ribcage|rib cage|pelvis|pelvic|front side|back side|shoulder|shoulders|scapula|scapular|arm|elbow|wrist|hand|back|spine|lumbar|thoracic|load|loading|rotation|rotate|transfer|brace|stack|stacked|contact|backswing|serve|swing|release|front leg|back leg|glute|glutes)\b/i.test(
    text,
  );
}

function isVagueMechanismStatement(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return true;

  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

  const exactVaguePatterns = [
    /^this is (?:about )?timing[.!?]?$/i,
    /^this is coordination[.!?]?$/i,
    /^this is a movement issue[.!?]?$/i,
    /^this is a sequencing issue[.!?]?$/i,
    /^something is off in the sequence[.!?]?$/i,
    /^your body is trying to adjust[.!?]?$/i,
    /^this is movement[.!?]?$/i,
    /^this is mechanics[.!?]?$/i,
    /^this is alignment[.!?]?$/i,
    /^this is a good sign[.!?]?$/i,
    /^this should help[.!?]?$/i,
  ];

  if (exactVaguePatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return /\b(?:this is|it is|it'?s|that is|that'?s)\s+(?:about\s+)?(?:timing|coordination|movement|mechanics|alignment|sequence|sequencing)\b/i.test(
    normalized,
  );
}

function normalizeHypothesisMeaning(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[*_`#>\-\[\]()'",.:;!?]/g, " ")
    .replace(
      /\b(?:your|you are|you're|youre|the issue is|the problem is|what's happening is|what’s happening is|what's going on is|what’s going on is|this is happening because|this usually comes from|this comes from|this is driven by|because|due to|coming from|comes from|is coming from)\b/g,
      " ",
    )
    .replace(/\bopen(?:ing)? early(?: through)?\b/g, " opening too early ")
    .replace(/\bopening too early(?: in| through)?\b/g, " opening too early ")
    .replace(/\bshift(?:ing)? early\b/g, " shifting too early ")
    .replace(/\blose(?:s|ing)? structure\b/g, " losing structure ")
    .replace(/\btake(?:s|ing)? over\b/g, " taking over ")
    .replace(/\bbear(?:ing|s)?(?: the)? load\b/g, " bearing load ")
    .replace(
      /\bstall(?:ing|s)? under(?: the)? load\b/g,
      " stalling under load ",
    )
    .replace(/\bdrop(?:ping|s)? too early\b/g, " dropping too early ")
    .replace(/\bcompensat(?:e|es|ing)\b/g, " compensating ")
    .replace(/\brotat(?:e|es|ing|ion)\b/g, " rotation ")
    .replace(/\bload(?:ing)?\b/g, " load ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeHypothesisMeaning(value: string | null | undefined): string[] {
  const stopwords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "that",
    "this",
    "it",
    "in",
    "on",
    "at",
    "to",
    "of",
    "for",
    "and",
    "with",
    "before",
    "after",
    "once",
    "still",
    "through",
    "into",
    "from",
    "under",
    "up",
    "down",
    "too",
    "early",
  ]);

  return normalizeHypothesisMeaning(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !stopwords.has(token));
}

function areMateriallyEquivalentHypotheses(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftNormalized = normalizeHypothesisMeaning(left);
  const rightNormalized = normalizeHypothesisMeaning(right);

  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized) return true;

  const leftTokens = tokenizeHypothesisMeaning(leftNormalized);
  const rightTokens = tokenizeHypothesisMeaning(rightNormalized);

  if (leftTokens.length === 0 || rightTokens.length === 0) return false;

  const smaller =
    leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const largerSet = new Set(
    leftTokens.length <= rightTokens.length ? rightTokens : leftTokens,
  );

  const sharedCount = smaller.filter((token) => largerSet.has(token)).length;

  return sharedCount >= Math.max(3, smaller.length - 1);
}

function hasAdjustmentDirectiveStart(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  return /^(?:focus on|try|make sure|let|allow|shift|keep|think about|load|relax|drive|rotate|brace|stack|press|pull|push|hinge|hold|stay)\b/i.test(
    text,
  );
}

function hasConcreteAdjustmentAnchor(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  return /\b(?:hip|hips|trunk|ribcage|rib cage|pelvis|pelvic|shoulder|shoulders|back|spine|front leg|front side|back leg|glute|glutes|contact|backswing|serve|swing|rotation|rotate|load|release|transfer|brace|stack|structure)\b/i.test(
    text,
  );
}

function hasDiagnosisLanguage(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  return /\b(?:because|since|due to|caused by|driven by|the issue is|the problem is|what'?s happening is|which means|so that)\b/i.test(
    text,
  );
}

function isLowInformationAdjustmentText(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return true;

  return (
    /\bstay aware of\b/i.test(text) ||
    /\bbe aware of\b/i.test(text) ||
    /\bkeep working on\b/i.test(text) ||
    /\bconsistency\b/i.test(text) ||
    /\bjust keep doing that\b/i.test(text) ||
    /\bbe mindful of\b/i.test(text) ||
    /\bthis should help\b/i.test(text) ||
    /\bthat should help\b/i.test(text) ||
    /\bclean things up\b/i.test(text) ||
    /\bgood place to start\b/i.test(text) ||
    /\bimprove the sequence\b/i.test(text) ||
    /\bstay organized\b/i.test(text) ||
    /\bmove better\b/i.test(text) ||
    /\bcontrol it more\b/i.test(text) ||
    /\bclean that up\b/i.test(text)
  );
}

function isClearlyBundledAdjustmentSequence(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  const directiveMatches =
    text.match(
      /\b(?:focus on|try|make sure|let|allow|shift|keep|think about|load|relax|drive|rotate|brace|stack|press|pull|push|hinge|hold|stay|clear)\b/gi,
    ) ?? [];

  if (directiveMatches.length >= 4) return true;

  if (
    directiveMatches.length >= 3 &&
    (/,/.test(text) || /\band\b|\bthen\b|\bwhile\b/i.test(text))
  ) {
    return true;
  }

  if (
    /\bfirst\b.*\bthen\b/i.test(text) ||
    /\bwhile keeping\b/i.test(text) ||
    /,\s*(?:keep|load|rotate|brace|hold|stay|clear)\b/i.test(text)
  ) {
    return true;
  }

  return false;
}

function canonicalizeAdjustmentMeaning(
  value: string | null | undefined,
): string {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[*_`#>\-\[\]()'",.:;!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return "";

  if (
    /\b(?:keep the )?(?:ribcage|rib cage)\s+(?:stacked|structure)\b.*\b(?:through rotation|as you rotate|into rotation)\b/i.test(
      normalized,
    ) ||
    /\bstay stacked\b.*\b(?:through rotation|as you rotate|into rotation)\b/i.test(
      normalized,
    ) ||
    /\bhold (?:the )?(?:ribcage )?structure\b.*\b(?:through rotation|as you rotate|into rotation)\b/i.test(
      normalized,
    )
  ) {
    return "ribcage stacked through rotation";
  }

  if (
    /\blet (?:the )?hip turn before (?:the )?trunk\b/i.test(normalized) ||
    /\ballow (?:the )?hip to turn first before (?:the )?trunk(?: goes| turns)?\b/i.test(
      normalized,
    ) ||
    /\bhip first trunk second\b/i.test(normalized) ||
    /\bhip first[, ]+trunk second\b/i.test(normalized)
  ) {
    return "hip before trunk";
  }

  return normalized;
}

function extractAdjustmentTargetSet(
  value: string | null | undefined,
): Set<string> {
  const text = canonicalizeAdjustmentMeaning(value);
  const targets = new Set<string>();

  const patterns: Array<[string, RegExp]> = [
    ["hip", /\bhip\b/i],
    ["trunk", /\btrunk\b/i],
    ["ribcage", /\bribcage|rib cage\b/i],
    ["pelvis", /\bpelvis|pelvic\b/i],
    ["shoulder", /\bshoulder\b/i],
    ["back", /\bback|spine\b/i],
    ["front-leg", /\bfront leg\b/i],
    ["front-side", /\bfront side\b/i],
    ["contact", /\bcontact\b/i],
    ["transfer", /\btransfer\b/i],
    ["release", /\brelease\b/i],
    ["rotation", /\brotation|rotate\b/i],
    ["load", /\bload\b/i],
    ["structure", /\bstructure|stacked|stack\b/i],
    ["brace", /\bbrace\b/i],
  ];

  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) targets.add(label);
  }

  return targets;
}

function extractAdjustmentGoalSet(
  value: string | null | undefined,
): Set<string> {
  const text = canonicalizeAdjustmentMeaning(value);
  const goals = new Set<string>();

  const patterns: Array<[string, RegExp]> = [
    ["brace", /\bbrace\b/i],
    ["stay-over", /\bstay over\b/i],
    ["stack", /\bstacked|stack\b/i],
    ["hold-structure", /\bhold structure|structure\b/i],
    ["load", /\bload\b/i],
    ["turn-before", /\bbefore\b.*\btrunk\b|\bhip before trunk\b/i],
    ["rotate", /\brotate|rotation\b/i],
    ["transfer", /\btransfer\b/i],
    ["release", /\brelease\b/i],
    ["contact", /\bcontact\b/i],
  ];

  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) goals.add(label);
  }

  return goals;
}

function tokenizeAdjustmentMeaning(value: string | null | undefined): string[] {
  const stopwords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "that",
    "this",
    "it",
    "in",
    "on",
    "at",
    "to",
    "of",
    "for",
    "and",
    "with",
    "you",
    "your",
    "as",
    "into",
    "through",
    "before",
    "after",
    "first",
    "second",
  ]);

  return canonicalizeAdjustmentMeaning(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !stopwords.has(token));
}

function areMateriallyEquivalentAdjustments(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftCanonical = canonicalizeAdjustmentMeaning(left);
  const rightCanonical = canonicalizeAdjustmentMeaning(right);

  if (!leftCanonical || !rightCanonical) return false;
  if (leftCanonical === rightCanonical) return true;

  const leftTargets = extractAdjustmentTargetSet(leftCanonical);
  const rightTargets = extractAdjustmentTargetSet(rightCanonical);
  const leftGoals = extractAdjustmentGoalSet(leftCanonical);
  const rightGoals = extractAdjustmentGoalSet(rightCanonical);

  const sameTargets =
    leftTargets.size > 0 &&
    rightTargets.size > 0 &&
    [...leftTargets].every((token) => rightTargets.has(token)) &&
    [...rightTargets].every((token) => leftTargets.has(token));

  const sameGoals =
    leftGoals.size > 0 &&
    rightGoals.size > 0 &&
    [...leftGoals].every((token) => rightGoals.has(token)) &&
    [...rightGoals].every((token) => leftGoals.has(token));

  if (sameTargets && sameGoals) {
    const leftTokens = tokenizeAdjustmentMeaning(leftCanonical);
    const rightTokens = tokenizeAdjustmentMeaning(rightCanonical);
    const smaller =
      leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
    const largerSet = new Set(
      leftTokens.length <= rightTokens.length ? rightTokens : leftTokens,
    );
    const sharedCount = smaller.filter((token) => largerSet.has(token)).length;
    return sharedCount >= Math.max(2, smaller.length - 1);
  }

  return false;
}

function isStrongHypothesisCandidate(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;
  if (text.length < 45) return false;
  if (text.length > 260) return false;
  if (isGenericCoachingFillerText(text)) return false;
  if (isTestLikeText(text)) return false;
  if (isVagueMechanismStatement(text)) return false;

  const directivePatterns = [
    /^\s*focus on\b/i,
    /^\s*try\b/i,
    /^\s*make sure\b/i,
    /^\s*keep\b/i,
    /^\s*let\b/i,
    /^\s*allow\b/i,
    /^\s*shift\b/i,
    /^\s*think about\b/i,
    /^\s*work on\b/i,
  ];

  const vagueInterpretationPatterns = [
    /\bthis is working\b/i,
    /\baligning well\b/i,
    /\bgood sign\b/i,
    /\bthis should help\b/i,
    /\bthat should help\b/i,
    /\bthe key is\b/i,
    /\bimportant thing\b/i,
    /\bthis is timing\b/i,
    /\bthis is coordination\b/i,
    /\bmovement issue\b/i,
    /\bsequence issue\b/i,
    /\balignment issue\b/i,
  ];

  if (directivePatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (vagueInterpretationPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (!hasMechanismAnchor(text)) {
    return false;
  }

  const hasMechanismSignal =
    hasExplanatoryMechanismLanguage(text) ||
    hasMechanismBreakdownLanguage(text);

  if (!hasMechanismSignal) {
    return false;
  }

  return true;
}

function isStrongAdjustmentCandidate(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;
  if (text.length < 20) return false;
  if (text.length > 180) return false;
  if (isGenericCoachingFillerText(text)) return false;
  if (isLowInformationAdjustmentText(text)) return false;
  if (!isTestLikeText(text)) return false;
  if (isMechanismLikeText(text)) return false;
  if (hasDiagnosisLanguage(text)) return false;
  if (isClearlyBundledAdjustmentSequence(text)) return false;
  if (!hasAdjustmentDirectiveStart(text)) return false;
  if (!hasConcreteAdjustmentAnchor(text)) return false;

  const vagueActionPatterns = [
    /\bmove better\b/i,
    /\bstay organized\b/i,
    /\bimprove the sequence\b/i,
    /\bcontrol it more\b/i,
    /\bclean that up\b/i,
    /\bclean things up\b/i,
    /\bwork on it\b/i,
    /\bkeep doing that\b/i,
  ];

  const rejectMixedPatterns = [
    /\bbecause\b/i,
    /\bdue to\b/i,
    /\bdriven by\b/i,
    /\bcaused by\b/i,
    /\bsince\b/i,
    /\bthe issue is\b/i,
    /\bthe problem is\b/i,
    /\bthis is happening\b/i,
    /\bwhich means\b/i,
    /\bso that\b/i,
  ];

  if (vagueActionPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (rejectMixedPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  return true;
}

function isLowSignalShiftText(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return true;

  return (
    /\bi found (?:an?|some)\b/i.test(text) ||
    /\bi watched\b/i.test(text) ||
    /\bi saw\b.*\bonline\b/i.test(text) ||
    /\bi found\b.*\bonline\b/i.test(text) ||
    /\bi came across\b/i.test(text) ||
    /\bon youtube\b/i.test(text) ||
    /\bin a video\b/i.test(text) ||
    /\bin an article\b/i.test(text) ||
    /\bthis is working\b/i.test(text) ||
    /\baligning well\b/i.test(text) ||
    /\bgood sign\b/i.test(text) ||
    /\bthe key is\b/i.test(text) ||
    /\bthis should help\b/i.test(text) ||
    /\bthat should help\b/i.test(text) ||
    /\bglad to hear\b/i.test(text) ||
    /\bkeep it up\b/i.test(text)
  );
}

function areEquivalentDashboardCandidates(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftNormalized = normalizeDashboardCandidate(left);
  const rightNormalized = normalizeDashboardCandidate(right);

  return leftNormalized !== "" && leftNormalized === rightNormalized;
}

function cleanDashboardTitlePart(
  value: string | null | undefined,
): string | null {
  const normalized = normalizePreviewValue(value);
  if (!normalized) return null;

  const cleaned = normalized.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const weakExactLabels = new Set([
    "general movement",
    "movement",
    "issue",
    "problem",
    "pain",
    "feels off",
    "something is off",
    "body feels off",
    "not right",
    "bad",
    "unspecified",
  ]);

  const cleanedKey = normalizeCaseKey(cleaned);
  if (weakExactLabels.has(cleanedKey)) return null;

  const weakSentenceFragmentPatterns = [
    /^(?:my\s+)?body\s+felt\s+(?:weird|off|wrong)$/i,
    /^(?:something|it)\s+(?:was|felt|is)\s+(?:wrong|off|bad)$/i,
    /^(?:my\s+)?[a-z\s]+?\s+was\s+bad$/i,
    /^(?:it|this)\s+felt\s+off$/i,
    /^(?:my\s+)?[a-z\s]+?\s+felt\s+(?:weird|off|wrong)$/i,
  ];

  if (weakSentenceFragmentPatterns.some((pattern) => pattern.test(cleaned))) {
    return null;
  }

  return cleaned;
}

function getDisplayableMovementContext(
  value: string | null | undefined,
): string | null {
  const cleaned = cleanDashboardTitlePart(value);
  if (!cleaned) return null;

  const validMovementLabels = new Set([
    "hip",
    "back",
    "knee",
    "ankle",
    "shoulder",
    "serve",
    "swing",
    "hinge",
    "lunge",
    "deadlift",
  ]);

  const lowInformationMovementLabels = new Set([
    "movement",
    "issue",
    "problem",
    "pain",
    "bad",
  ]);

  if (lowInformationMovementLabels.has(normalizeCaseKey(cleaned))) {
    return null;
  }

  if (
    cleaned.length <= 3 &&
    !validMovementLabels.has(normalizeCaseKey(cleaned))
  ) {
    return null;
  }

  return cleaned;
}

function getDisplayableActivityType(
  value: string | null | undefined,
): string | null {
  const cleaned = cleanDashboardTitlePart(value);
  if (!cleaned) return null;

  const validActivityLabels = new Set([
    "hip",
    "back",
    "knee",
    "ankle",
    "shoulder",
    "serve",
    "swing",
    "hinge",
    "lunge",
    "deadlift",
  ]);

  if (
    cleaned.length <= 3 &&
    !validActivityLabels.has(normalizeCaseKey(cleaned))
  ) {
    return null;
  }

  return cleaned;
}

function buildActiveCaseTitle(
  movementContext: string | null | undefined,
  activityType: string | null | undefined,
): string | null {
  const movement = getDisplayableMovementContext(movementContext);
  const activity = getDisplayableActivityType(activityType);

  if (movement && activity) return `${movement} — ${activity}`;
  return movement ?? activity ?? null;
}

function qualifiesForTimelineSignal(text: string): boolean {
  const input = text.trim().toLowerCase();
  if (!input) return false;

  const hasBodyRegion =
    /\b(?:hip|back|low back|mid back|shoulder|knee|ankle|elbow|wrist|neck|foot|feet|leg|arm|glute|spine|lumbar|thoracic|hamstring|quad|calf|shin)\b/i.test(
      input,
    );

  const hasStrongSymptom =
    /\b(?:pain|painful|tight|tightness|stiff|stiffness|sore|soreness|hurt|hurts|hurting|discomfort|pinch|pinching|pinched|ache|aching|cannot|can't|cant|limited|limitation|restricted|unstable|instability)\b/i.test(
      input,
    );

  const hasMovementMechanic =
    /\b(?:rotate|rotation|load|hinge|swing|serve|backswing|contact point|contact|coordination|breakdown|breaks down|collapse|collapses|shift|shifting|compensation|compensating|lunge|deadlift|squat|brace|stack)\b/i.test(
      input,
    );

  const hasSpecificMovementBreakdown =
    /\b(?:timing is off on (?:my )?(?:serve|swing)|my timing is off at contact|timing breaks down on (?:the )?backswing|unstable at contact|can't load|cant load|breaks down on (?:the )?backswing|collapses when i rotate|collapses when i lunge|can't rotate|cant rotate|can't hinge|cant hinge|hurts on (?:the )?backswing|tightens when i rotate)\b/i.test(
      input,
    ) ||
    /\b(?:collapses|breaks down|gives out)\b.*\b(?:when|on|during)\b.*\b(?:rotate|rotation|lunge|serve|swing|backswing|contact)\b/i.test(
      input,
    ) ||
    /\b(?:cannot|can't|cant)\b.*\b(?:load|rotate|hinge|swing|serve)\b/i.test(
      input,
    );

  return (
    (hasStrongSymptom && hasBodyRegion) ||
    (hasStrongSymptom && hasMovementMechanic) ||
    hasSpecificMovementBreakdown
  );
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

function detectUserClosureSignal(text: string): boolean {
  const input = text.trim();
  if (!input) return false;

  return /\b(thank you|thanks|that helped|this helped|that makes sense|perfect|got it|exactly|that was what i needed|that's what i needed|that is what i needed|that’s what i needed|that’s a great plan|that is a great plan|great plan|understood|makes sense now|all good|we're good|we are good|i'm good|im good|all set|that answers it|that answered it)\b/i.test(
    input,
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
    if (!convo.summary?.trim()) continue;

    sessionBlocks.push(
      `--- Session (conversation ${convo.id}, title: "${convo.title}") ---\nSummary: ${convo.summary.trim()}\n`,
    );
  }

  if (sessionBlocks.length === 0) return "";

  return (
    "\n\n=== STORED SESSION HISTORY ===\n" +
    "Compressed prior-session summaries. Use only when directly relevant.\n\n" +
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

async function getCurrentConversationSummaryBlock(
  conversationId: number,
): Promise<string> {
  const [convo] = await db
    .select({
      summary: conversations.summary,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const summary = String(convo?.summary ?? "").trim();
  if (!summary) return "";

  return `
=== CURRENT CONVERSATION SUMMARY ===
Compressed thread state so far:
${summary}
`;
}

// ==============================
// RESPONSE VALIDATION HELPERS
// ==============================

function isValidResponse(text: string): boolean {
  if (!text) return false;

  if (!text.trim()) return false;

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

  app.get("/api/settings", isAuthenticated, async (req: any, res: any) => {
    try {
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const userRecord = await ensureUserRecord(userId, authUser);
      const memory = await getMemory(userId);

      res.json(buildPersistedSettings(userRecord?.firstName, memory));
    } catch (err) {
      console.error("Failed to load settings:", err);
      res.status(500).json({ error: "Failed to load settings" });
    }
  });

  app.post("/api/settings", isAuthenticated, async (req: any, res: any) => {
    try {
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      await ensureUserRecord(userId, authUser);

      const body = req.body ?? {};

      const name = normalizeStoredFirstName(body.name);
      const age = normalizeAgeForMemory(body.age);
      const height = normalizeSettingsText(body.height) || null;
      const weight = normalizeSettingsText(body.weight) || null;
      const primaryActivity =
        normalizeSettingsText(body.primaryActivity) || null;
      const dominantHand = normalizeSettingsText(body.dominantHand);
      const normalizedDominantHand =
        dominantHand === "left" || dominantHand === "right"
          ? dominantHand
          : null;
      const activityLevel = normalizeSettingsText(body.activityLevel);
      const competitionLevel =
        normalizeSettingsText(body.competitionLevel) || null;
      const voice = normalizeSettingsVoice(body.voice);
      const completed = normalizeCompletedFlag(body.completed);

      await db
        .update(users)
        .set({
          firstName: name,
          email: authUser?.claims?.email ?? null,
        })
        .where(eq(users.id, userId));

      await updateMemory(userId, (memory) => {
        memory.identity.name = name;
        memory.identity.age = age;
        memory.identity.height = height;
        memory.identity.weight = weight;
        memory.identity.dominantHand = normalizedDominantHand;
        memory.sportContext.primarySport = primaryActivity;
        memory.sportContext.competitionLevel = competitionLevel;

        const memoryWithPreferences = memory as typeof memory & {
          preferences?: {
            voice?: string;
            activityLevel?: string | null;
            setupCompleted?: boolean;
          };
        };

        if (!memoryWithPreferences.preferences) {
          memoryWithPreferences.preferences = {};
        }

        memoryWithPreferences.preferences.voice = voice;
        memoryWithPreferences.preferences.activityLevel = activityLevel || null;
        memoryWithPreferences.preferences.setupCompleted = completed;
      });

      const updatedMemory = await getMemory(userId);

      res.json(buildPersistedSettings(name, updatedMemory));
    } catch (err) {
      console.error("Failed to save settings:", err);
      res.status(500).json({ error: "Failed to save settings" });
    }
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

  app.post("/api/tts", isAuthenticated, async (req: any, res: Response) => {
    try {
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { text } = req.body ?? {};

      if (!text || !text.trim()) {
        return res.status(400).json({ error: "No text provided" });
      }

      const processedText = text.replace(/—/g, " — ").replace(/…/g, "... ");
      const memory = await getMemory(userId);

      const settingsVoice =
        normalizeSettingsVoice((memory as any)?.preferences?.voice) ||
        "male_coach";

      const voiceId = INTERLOOP_SETTINGS_VOICE_IDS[settingsVoice];

      const selectedVoice = {
        voiceId,
        modelId: "eleven_multilingual_v2",
        settings:
          settingsVoice === "female_pilates" || settingsVoice === "female_yoga"
            ? {
                stability: 0.36,
                similarity_boost: 0.85,
                style: 0.18,
                use_speaker_boost: true,
                speed: 0.92,
              }
            : {
                stability: 0.38,
                similarity_boost: 0.85,
                style: 0.15,
                use_speaker_boost: true,
                speed: 0.92,
              },
      };

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

  app.get("/api/dashboard", isAuthenticated, async (req: any, res: any) => {
    try {
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const recentCases = await db
        .select({
          id: cases.id,
          movementContext: cases.movementContext,
          activityType: cases.activityType,
          status: cases.status,
          updatedAt: cases.updatedAt,
        })
        .from(cases)
        .where(eq(cases.userId, userId))
        .orderBy(desc(cases.updatedAt), desc(cases.id))
        .limit(12);

      const meaningfulCases = recentCases.filter((row) => {
        const movement = normalizeOptionalLabel(row.movementContext);
        const activity = normalizeOptionalLabel(row.activityType);

        const isWeakMovement =
          movement === "" || movement === "general movement";

        const isWeakActivity = activity === "" || activity === "unspecified";

        return !(isWeakMovement && isWeakActivity);
      });

      const selectedCase =
        meaningfulCases.find((row) => isOpenCaseStatus(row.status)) ??
        meaningfulCases[0] ??
        recentCases.find((row) => isOpenCaseStatus(row.status)) ??
        recentCases[0] ??
        null;

      let latestAdjustment:
        | {
            mechanicalFocus: string | null;
            cue: string | null;
          }
        | undefined;
      let latestHypothesis:
        | {
            hypothesis: string | null;
          }
        | undefined;
      let latestOutcome:
        | {
            result: string | null;
            userFeedback: string | null;
          }
        | undefined;
      let latestSignal:
        | {
            description: string | null;
          }
        | undefined;

      if (selectedCase) {
        [latestAdjustment] = await db
          .select({
            mechanicalFocus: caseAdjustments.mechanicalFocus,
            cue: caseAdjustments.cue,
          })
          .from(caseAdjustments)
          .where(eq(caseAdjustments.caseId, selectedCase.id))
          .orderBy(desc(caseAdjustments.id))
          .limit(1);

        [latestHypothesis] = await db
          .select({
            hypothesis: caseHypotheses.hypothesis,
          })
          .from(caseHypotheses)
          .where(eq(caseHypotheses.caseId, selectedCase.id))
          .orderBy(desc(caseHypotheses.id))
          .limit(1);

        [latestOutcome] = await db
          .select({
            result: caseOutcomes.result,
            userFeedback: caseOutcomes.userFeedback,
          })
          .from(caseOutcomes)
          .where(eq(caseOutcomes.caseId, selectedCase.id))
          .orderBy(desc(caseOutcomes.id))
          .limit(1);

        [latestSignal] = await db
          .select({
            description: caseSignals.description,
          })
          .from(caseSignals)
          .where(eq(caseSignals.caseId, selectedCase.id))
          .orderBy(desc(caseSignals.id))
          .limit(1);
      }

      let latestCaseReview:
        | {
            id: number;
            caseId: number;
            reviewText: string | null;
            createdAt: Date | null;
          }
        | undefined;
      let caseReviewsList: Array<{
        id: number;
        caseId: number;
        reviewText: string | null;
        createdAt: Date | null;
      }> = [];

      if (selectedCase) {
        [latestCaseReview] = await db
          .select({
            id: caseReviews.id,
            caseId: caseReviews.caseId,
            reviewText: caseReviews.reviewText,
            createdAt: caseReviews.createdAt,
          })
          .from(caseReviews)
          .where(eq(caseReviews.caseId, selectedCase.id))
          .orderBy(desc(caseReviews.id))
          .limit(1);
      }

      caseReviewsList = await db
        .select({
          id: caseReviews.id,
          caseId: caseReviews.caseId,
          reviewText: caseReviews.reviewText,
          createdAt: caseReviews.createdAt,
        })
        .from(caseReviews)
        .innerJoin(cases, eq(caseReviews.caseId, cases.id))
        .where(eq(cases.userId, userId))
        .orderBy(desc(caseReviews.createdAt))
        .limit(5);

      const activeCaseTitle = buildActiveCaseTitle(
        selectedCase?.movementContext,
        selectedCase?.activityType,
      );
      const latestOutcomeResult = String(latestOutcome?.result ?? "").trim();
      const investigationState = !selectedCase
        ? null
        : latestOutcomeResult === "Improved"
          ? "Resolved"
          : latestOutcomeResult === "Same" || latestOutcomeResult === "Worse"
            ? "Testing (no improvement)"
            : latestAdjustment
              ? "Testing"
              : latestHypothesis
                ? "Narrowing"
                : "Open";
      const mechanismSourceCandidates = [
        normalizePreviewValue(latestHypothesis?.hypothesis),
        normalizePreviewValue(latestAdjustment?.mechanicalFocus),
      ];
      const selectedMechanismSource =
        mechanismSourceCandidates.find((candidate) =>
          isMechanismLikeText(candidate),
        ) ?? null;
      const currentMechanism = extractPreviewSnippet(
        selectedMechanismSource,
        220,
      );

      const testSourceCandidates = [
        normalizePreviewValue(latestAdjustment?.cue),
        normalizePreviewValue(latestAdjustment?.mechanicalFocus),
      ].filter((candidate): candidate is string => Boolean(candidate));
      const selectedTestSource =
        testSourceCandidates.find(
          (candidate) =>
            isTestLikeText(candidate) &&
            !areEquivalentDashboardCandidates(
              candidate,
              selectedMechanismSource,
            ),
        ) ?? null;
      const currentTest = extractPreviewSnippet(selectedTestSource, 220);

      const shiftSourceCandidates = [
        {
          value: normalizePreviewValue(latestAdjustment?.cue),
          allowLowSignalFallback: false,
        },
        {
          value: normalizePreviewValue(latestHypothesis?.hypothesis),
          allowLowSignalFallback: false,
        },
        {
          value: normalizePreviewValue(latestOutcome?.userFeedback),
          allowLowSignalFallback: false,
        },
        {
          value: normalizePreviewValue(latestSignal?.description),
          allowLowSignalFallback: true,
        },
      ].filter(
        (
          candidate,
        ): candidate is {
          value: string;
          allowLowSignalFallback: boolean;
        } => Boolean(candidate.value),
      );
      const selectedShiftSource =
        shiftSourceCandidates.find(
          (candidate) => !isLowSignalShiftText(candidate.value),
        )?.value ??
        shiftSourceCandidates.find(
          (candidate) => candidate.allowLowSignalFallback,
        )?.value ??
        null;
      const lastShift = extractPreviewSnippet(selectedShiftSource, 220);
      const lastCaseReviewSnippet = extractPreviewSnippet(
        latestCaseReview?.reviewText,
        220,
      );

      console.log("DASHBOARD DEBUG:", {
        userId,
        selectedCaseId: selectedCase?.id ?? null,
        movementContext: selectedCase?.movementContext ?? null,
        activityType: selectedCase?.activityType ?? null,
        activeCaseTitle,
        investigationState,
        currentMechanism,
        currentTest,
        lastShift,
        hasLatestCaseReview: Boolean(latestCaseReview?.reviewText),
        caseReviewsCount: caseReviewsList.length,
        lastCaseReviewSnippet,
      });

      res.json({
        activeCaseTitle,
        investigationState,
        currentMechanism,
        currentTest,
        lastShift,
        lastCaseReviewSnippet,
        caseReviewsList,
      });
    } catch (err) {
      console.error("Failed to load dashboard preview:", err);
      res.status(500).json({ error: "Failed to load dashboard preview" });
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
        const storedFirstName = dbFirstName;

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

        let resolvedActiveCase: {
          id: number;
          userId: string;
          conversationId: number | null;
          movementContext: string | null;
          activityType: string | null;
          status: string | null;
        } | null = null;

        resolvedActiveCase = await getConversationOpenCase(userId, convoId);

        try {
          const outcomeResult = detectOutcomeResult(userText);

          if (outcomeResult) {
            if (!resolvedActiveCase) {
              resolvedActiveCase = await getConversationOpenCase(
                userId,
                convoId,
              );
            }

            const activeCase = resolvedActiveCase;

            if (activeCase && isOpenCaseStatus(activeCase.status)) {
              const [latestOutcome] = await db
                .select({
                  id: caseOutcomes.id,
                  result: caseOutcomes.result,
                  createdAt: caseOutcomes.createdAt,
                })
                .from(caseOutcomes)
                .where(eq(caseOutcomes.caseId, activeCase.id))
                .orderBy(desc(caseOutcomes.id))
                .limit(1);

              const latestCreatedAtMs = latestOutcome?.createdAt
                ? new Date(latestOutcome.createdAt).getTime()
                : 0;

              const isDuplicateRecentOutcome =
                Boolean(latestOutcome) &&
                String(latestOutcome.result ?? "") === outcomeResult &&
                latestCreatedAtMs > 0 &&
                Date.now() - latestCreatedAtMs <= 1000 * 60 * 10;

              if (!isDuplicateRecentOutcome) {
                await db.insert(caseOutcomes).values({
                  caseId: activeCase.id,
                  result: outcomeResult,
                  userFeedback: userText,
                });

                if (outcomeResult === "Improved") {
                  await db
                    .update(cases)
                    .set({ status: "resolved" })
                    .where(eq(cases.id, activeCase.id));
                }
              }
            }
          }
        } catch (err) {
          console.error("Auto outcome capture failed:", err);
        }

        try {
          const shouldCreateCase =
            !isCaseReview && qualifiesForTimelineSignal(userText);

          if (shouldCreateCase) {
            const derivedCaseContext = deriveCaseContext(userText);
            const derivedBodyRegion = deriveBodyRegion(userText);
            const derivedSignalType = deriveSignalType(userText);
            if (!resolvedActiveCase) {
              resolvedActiveCase = await getConversationOpenCase(
                userId,
                convoId,
              );
            }

            if (resolvedActiveCase) {
              await db.insert(caseSignals).values({
                userId,
                caseId: resolvedActiveCase.id,
                description: clampText(userText, 800),
                activityType: derivedCaseContext.activityType,
                movementContext: derivedCaseContext.movementContext,
                bodyRegion: derivedBodyRegion,
                signalType: derivedSignalType,
              });
            } else {
              let newCase:
                | {
                    id: number;
                    userId: string;
                    conversationId: number | null;
                    movementContext: string | null;
                    activityType: string | null;
                    status: string | null;
                  }
                | undefined;

              try {
                [newCase] = await db
                  .insert(cases)
                  .values({
                    userId,
                    conversationId: convoId,
                    movementContext: derivedCaseContext.movementContext,
                    activityType: derivedCaseContext.activityType,
                    status: "open",
                  })
                  .returning();
              } catch (err) {
                console.error("Case creation failed:", err);
                throw err;
              }

              if (newCase) {
                resolvedActiveCase = newCase;

                try {
                  await db.insert(caseSignals).values({
                    userId,
                    caseId: newCase.id,
                    description: clampText(userText, 800),
                    activityType: derivedCaseContext.activityType,
                    movementContext: derivedCaseContext.movementContext,
                    bodyRegion: derivedBodyRegion,
                    signalType: derivedSignalType,
                  });
                } catch (err) {
                  console.error("Case signal write failed:", {
                    userId,
                    conversationId: convoId,
                    caseId: newCase.id,
                    derivedCaseContext,
                    userText,
                    ...formatUnknownError(err),
                  });

                  try {
                    await db.delete(cases).where(eq(cases.id, newCase.id));
                  } catch (deleteErr) {
                    console.error(
                      "Case rollback failed after signal write failure:",
                      {
                        userId,
                        conversationId: convoId,
                        caseId: newCase.id,
                        derivedCaseContext,
                        userText,
                        ...formatUnknownError(deleteErr),
                      },
                    );
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error("Case creation flow failed:", err);
        }

        if (!resolvedActiveCase) {
          resolvedActiveCase = await getConversationOpenCase(userId, convoId);
        }

        const memory = await getMemory(userId);
        const memoryBlock = buildMemoryPromptBlock(memory);
        const currentConversationSummaryBlock =
          await getCurrentConversationSummaryBlock(convoId);

        const activeHypothesisBlock = await getActiveHypothesisBlock(userId);
        const runtimePatternBlock =
          await getDominantRuntimePatternBlock(userId);
        const continuityBlock = activeHypothesisBlock || runtimePatternBlock;

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

If the current user message clearly fits an already established line:

- prefer continuity over restarting from scratch
- advance the existing line instead of restating it
- shift only when new evidence materially breaks the current explanation
- do not re-explain the same mechanism if it has already been established

If multiple details are present, use the strongest established line that still fits the evidence, but stay willing to update it when the new signal clearly demands it.
`
          : "";

        const endingStateBlock = !isCaseReview
          ? `
=== ENDING STATE RULE ===
The ending question is determined by state, not by template.
Use exactly one final question, and only if a real question is still needed.

State 0 — Light re-entry / check-in:
- If the user is lightly reopening the conversation without advancing the investigation yet, do not force narrowing, confirmation, or adjustment testing
- If there is a strong active thread, unresolved mechanism, or continuity line, reopen from that softly and ask what has changed, what has shown up, or what they are noticing now
- If there is no strong continuity thread, ask a light directional opening about what is going on today, what has been showing up, or what they want to look at
- This should feel like continuation, not intake and not small talk

State 1 — Mechanism unclear:
- End with a narrowing question that locates where, when, or under what condition the breakdown appears
- Focus on sequence, timing, load, or the point where the movement changes or collapses
- Do not end with an adjustment-testing question here

State 2 — Mechanism forming but not proven:
- End with a confirmation or falsification question that checks whether the likely explanation actually matches the breakdown
- Use a specific contrast or condition that can expose whether the read is right
- This is still not automatically an adjustment test

State 3 — Adjustment actually in play:
- Only if an actual adjustment has already been introduced in the current line may the ending question test whether it holds
- Then it can ask what changed after applying it, or whether it holds under speed, load, fatigue, or the full motion

State 4 — User-side closure:
- If the user clearly signals that the point landed, helped, or is complete, do not continue probing
- Briefly acknowledge it
- Stabilize the point
- Restate the lever cleanly only if useful
- Then either stop naturally without forcing another question, or use one light release line that does not reopen investigation

Hard constraint:
- If no adjustment has actually been introduced, do not end with an adjustment-testing question
- Do not default to "how did that feel", "what happened when you tried that", or any equivalent outcome loop unless an actual adjustment is already active
`
          : "";

        const userSideClosureBlock = !isCaseReview
          ? `
=== USER-SIDE CLOSURE RULE ===
If the user clearly signals that the point landed, helped, or is complete:
- do not keep explaining
- do not force a continuation question
- do not reopen the same reasoning
- briefly acknowledge it
- stabilize the point
- restate the lever cleanly only if useful
- then either stop naturally, or use one light release line that does not reopen investigation

Do not:
- ask a narrowing question
- ask a confirmation question
- ask a testing question
- continue reasoning
- reopen the same mechanism

A light release line:
- is optional
- is not a question
- does not probe
- does not test
- does not clarify
- does not continue the investigation
- simply lets the conversation land naturally
`
          : "";

        const internalReasoningBlock = !isCaseReview
          ? `
=== INTERNAL MECHANICS DOCTRINE ===
This layer is for hidden reasoning only. Do not expose it as labels or sections in the visible reply.

Before generating the response:
- extract the real physical signal
- consider multiple interpretations
- select the strongest mechanism
- correct the user's interpretation
- predict the most likely failure mode or overcorrection
- reduce the intervention to one lever
- optionally link the read to known patterns when it sharpens the explanation

Critical rule:
- think fully first, then speak naturally
- do not compress before reasoning
- do not expose this reasoning scaffold in the visible response
- do not use visible labels like "Mechanism", "Correction", "Risk", or "Lever"
`
          : "";

        const toneGuidanceBlock = !isCaseReview
          ? `
=== TONE GUIDANCE ===
- direct
- precise
- mechanism-first
- non-performative
- allow natural explanation and variable length when the reasoning needs it
- let the Base Narrative arc lead
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
            content: internalReasoningBlock.trim(),
          },
          {
            role: "system",
            content: `
Execution context for this conversation:

${identityBlock}

${currentConversationSummaryBlock}

${memoryBlock}

${continuityBlock}

${patternPriorityBlock}

${endingStateBlock}

${userSideClosureBlock}

${toneGuidanceBlock}
          `.trim(),
          },
          ...previous.slice(-16).map((m) => ({
            role: m.role as "user" | "assistant",
            content: String(m.content ?? ""),
          })),
        ];

        console.log("CHAT STAGE: openai-completion");

        let assistantText = await runCompletion(openai, chatMessages);
        let finalText = assistantText;

        if (!isCaseReview) {
          const userSignaledClosure = detectUserClosureSignal(userText);
          const isWeak =
            /could be|might be|possibly|several|a few things/i.test(
              assistantText,
            ) ||
            /aligning well|this is working|good sign|this suggests progress/i.test(
              assistantText,
            ) ||
            /\bthe key is\b/i.test(assistantText) ||
            /\bthis means\b/i.test(assistantText);

          const isGenericSuccess =
            /glad to hear|great to hear|happy to hear|fantastic|great to see|keep it up|let me know|feel free to reach out/i.test(
              assistantText,
            );

          const hasWeakMechanismLanguage =
            /aligning well|this is working|good sign|suggests progress/i.test(
              assistantText,
            ) || /\bthe key is\b/i.test(assistantText);

          const hasLabels =
            /hypothesis:|guardrail:|lever:|sequence:|narrowing question:/i.test(
              assistantText,
            );

          const hasFormattedSections = /\*\*.*\*\*:/g.test(assistantText);
          const closureDrift = userSignaledClosure && /\?/.test(assistantText);

          if (
            !isValidResponse(assistantText) ||
            isWeak ||
            hasWeakMechanismLanguage ||
            isGenericSuccess ||
            closureDrift ||
            hasLabels ||
            hasFormattedSections
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

=== CRITICAL MECHANISM ENFORCEMENT ===

All explanations must resolve to a physical or mechanical cause.

Do NOT say:
- this is working
- this is aligning well
- this is a good sign
- this means you're doing it right
- this suggests progress

Do NOT use generic interpretation language.

Instead:
- identify what is physically happening in the body
- describe what is breaking, collapsing, shifting, or compensating
- explain the mechanism directly

If the response does not contain a clear mechanical explanation, it is invalid and must be rewritten.

When the user reports improvement:
- translate it into a confirmed mechanism
- explain WHY it improved physically

Do not stop at success language.

=== LANGUAGE CONSTRAINT ===

Reject phrases like:
- "the key is"
- "this is working"
- "this aligns well"
- "this is a good sign"

These are invalid outputs and must not appear.

Required response behavior:
- Keep one dominant mechanism only
- Do not reopen multiple explanations or branches
- Preserve the natural Interloop arc: controlled validation, mechanism identification, interpretation correction, failure mode prediction, one lever, optional sequence or contextual tie, then one final question chosen from state
- Think fully before writing
- Use hidden reasoning to extract the real signal, consider multiple interpretations, choose the strongest mechanism, correct the user's interpretation, predict the likely failure mode, and reduce it to one lever
- Do not expose the reasoning scaffold as labels or sections
- Start by validating only what is actually correct, then immediately correct the user's misunderstanding in natural language
- Correct the user's misunderstanding directly, without labeling it or naming it
- If the user reports improvement or success, begin with brief earned validation, then explain what the improvement means mechanically
- When success is reported, identify the next likely breakdown, overcorrection, or relapse point instead of drifting into praise or closure
- If the mechanism is already established, advance it instead of restating it
- Do not repeat the same explanation in slightly different wording
- Each follow-up must move the investigation forward
- Identify the single most important error, misread, or drift point
- Correct that point directly and decisively
- Use contrast when useful (not X, Y)
- Compress the correction into one clear idea, expressed naturally inside the explanation
- Tie the correction to the user's known pattern/history when relevant
- Predict the most likely next overcorrection, compensation, failure, or relapse point
- Give one tight execution model, not multiple options
- Give one immediate real-world check for whether it is correct
- The ending question is determined by state, not by template
- End with at most one final question, and only if a real question is needed
- If the user is lightly reopening the conversation without materially advancing the investigation, use soft re-entry: reopen from continuity when it exists and ask what has changed, what has shown up, or what they are noticing now
- If the mechanism is still unclear, end with a narrowing question that locates where, when, or under what condition the breakdown appears
- If the mechanism is forming but not yet proven, end with a confirmation or falsification question that checks whether the read actually matches the breakdown
- Only if an actual adjustment has already been introduced in the current line may the ending question test whether it holds or what changed after applying it
- If no adjustment exists, do not ask an adjustment-testing question
- If the user clearly closes the point, do not ask any follow-up question
- In a closure response, brief acknowledgment is enough
- A closure response can be very short if it lands cleanly
- Do not expand a correct closure into a longer answer
- If the user says thank you, that helped, that makes sense, perfect, got it, exactly, or otherwise signals completion, let it land and stop naturally
- After closure, you may optionally use one light release line, but it must not reopen investigation
- A light release line is not a question and does not probe, test, clarify, or restart reasoning
- When the user reports that something worked, translate the success into mechanism confirmation, not encouragement
- Do not treat initial success as resolution; treat it as confirmation and only test it under variation if an actual adjustment is already active
- If success has been reported without a real adjustment in play, do not collapse into an adjustment/outcome loop; keep the final question aligned to the actual state of the investigation
- Before success is confirmed, do not ask a binary closure question; ask the question that best fits the current state: soft re-entry, narrowing, confirmation, or adjustment stress-test
- Make the final question specific and mechanically useful
- Prefer a specific condition check, contrast check, or binary probe when it sharpens the state-based question
- Allow natural phrasing, variable length, and variable structure when the reasoning needs it
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
- Make the final question specific and mechanically useful
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
          if (
            resolvedActiveCase &&
            isOpenCaseStatus(resolvedActiveCase.status)
          ) {
            const hypothesisSentence = extractBestHypothesisSentence(finalText);

            if (
              hypothesisSentence &&
              isStrongHypothesisCandidate(hypothesisSentence)
            ) {
              const [latestStoredHypothesis] = await db
                .select({
                  hypothesis: caseHypotheses.hypothesis,
                })
                .from(caseHypotheses)
                .where(eq(caseHypotheses.caseId, resolvedActiveCase.id))
                .orderBy(desc(caseHypotheses.id))
                .limit(1);

              if (
                !areMateriallyEquivalentHypotheses(
                  hypothesisSentence,
                  latestStoredHypothesis?.hypothesis,
                )
              ) {
                await db.insert(caseHypotheses).values({
                  caseId: resolvedActiveCase.id,
                  hypothesis: hypothesisSentence,
                });
              }
            }

            const adjustmentSentence = extractBestAdjustmentSentence(finalText);

            if (
              adjustmentSentence &&
              isStrongAdjustmentCandidate(adjustmentSentence) &&
              !isStrongHypothesisCandidate(adjustmentSentence) &&
              !areEquivalentDashboardCandidates(
                adjustmentSentence,
                hypothesisSentence,
              ) &&
              !areMateriallyEquivalentHypotheses(
                adjustmentSentence,
                hypothesisSentence,
              )
            ) {
              const [latestStoredAdjustment] = await db
                .select({
                  cue: caseAdjustments.cue,
                  mechanicalFocus: caseAdjustments.mechanicalFocus,
                })
                .from(caseAdjustments)
                .where(eq(caseAdjustments.caseId, resolvedActiveCase.id))
                .orderBy(desc(caseAdjustments.id))
                .limit(1);

              const isDuplicateAdjustment =
                areMateriallyEquivalentAdjustments(
                  adjustmentSentence,
                  latestStoredAdjustment?.cue,
                ) ||
                areMateriallyEquivalentAdjustments(
                  adjustmentSentence,
                  latestStoredAdjustment?.mechanicalFocus,
                );

              if (!isDuplicateAdjustment) {
                await db.insert(caseAdjustments).values({
                  caseId: resolvedActiveCase.id,
                  cue: adjustmentSentence,
                  mechanicalFocus: adjustmentSentence,
                });
              }
            }
          }
        } catch (err) {
          console.error("Case extraction write failed:", err);
        }

        try {
          console.log("CASE REVIEW WRITE CHECK:", {
            isCaseReview,
            assistantLength: finalText.length,
            userId,
          });

          if (isCaseReview && finalText.length > 60) {
            let caseReviewTarget = resolvedActiveCase;

            if (!caseReviewTarget) {
              caseReviewTarget = await getConversationOpenCase(userId, convoId);
            }

            console.log("CASE REVIEW TARGET:", caseReviewTarget?.id ?? null);

            if (caseReviewTarget) {
              await writeCaseReview({
                userId,
                caseId: caseReviewTarget.id,
                reviewText: finalText,
              });

              console.log("CASE REVIEW STORED:", caseReviewTarget.id);
            } else {
              console.warn(
                "CASE REVIEW SKIPPED: no conversation-scoped case found for user",
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

      const outcomeClassification = detectOutcomeResult(
        `${String(result ?? "")} ${String(userFeedback ?? "")}`.trim(),
      );

      if (outcomeClassification === "Improved") {
        await db
          .update(cases)
          .set({ status: "resolved" })
          .where(eq(cases.id, caseId));
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("Outcome capture failed:", err);
      res.status(500).json({ error: "Failed to store outcome" });
    }
  });
}

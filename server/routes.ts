// ==============================
// IMPORTS & SETUP
// ==============================

import { BASE_NARRATIVE_V2 } from "./prompts/base_narrative_v2_claude";
import { CASE_REVIEW_NARRATIVE } from "./prompts/caseReviewNarrative";
import { buildHistoricalStateReview } from "./prompts/historicalStateReview";
import { buildHistoricalStateReviewInput } from "./builders/buildHistoricalStateReviewInput";

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

function extractFirstMatchingSentence(
  text: string,
  patterns: RegExp[],
): string | null {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    if (patterns.some((pattern) => pattern.test(sentence))) {
      return clampText(sentence, 400);
    }
  }

  return null;
}

function qualifiesForTimelineSignal(text: string): boolean {
  return /pain|painful|tight|tightness|hurt|hurts|hurting|issue|problem|tweak|tweaked|strain|strained|straining|tension|discomfort|catching|catch|pinch|pinching|pinched|irritated|irritation|sore|soreness|stiff|stiffness|aggravated|aggravating|flare|flaring up|acting up|feels weird|feels wrong|not comfortable|uncomfortable|not sitting right|pulling|tugging|ache|aching|doesn't feel right|doesnt feel right|can't|cannot|struggle|confused|off|feels off|not right|not working|can't rotate|cant rotate|can't load|cant load|timing is off|timing feels off|mechanics feel wrong|movement is weird|doesn't feel stable|not stable|unstable|out of position|can't control|cant control|not coordinated|coordination is off|out of sync|awkward|something is off|rotation feels off|trunk rotation feels wrong/i.test(
    text.trim(),
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
                speed: 1.08,
              }
            : {
                stability: 0.38,
                similarity_boost: 0.85,
                style: 0.15,
                use_speaker_boost: true,
                speed: 1.06,
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

  app.post(
    "/api/historical-state-review",
    isAuthenticated,
    async (req: Request, res: Response) => {
      try {
        const authUser = req.user as any;
        const userId = authUser?.claims?.sub;

        if (!userId) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        const reviewInput = await buildHistoricalStateReviewInput(userId);
        const historicalReview = await buildHistoricalStateReview(reviewInput);

        res.json({ historicalReview });
      } catch (err) {
        console.error("Historical state review failed:", err);
        res.status(500).json({ error: "Failed to generate historical review" });
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
        let storedFirstName = dbFirstName;

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
          const outcomeResult = detectOutcomeResult(userText);

          if (outcomeResult) {
            const [activeCase] = await db
              .select({
                id: cases.id,
                status: cases.status,
              })
              .from(cases)
              .where(eq(cases.userId, userId))
              .orderBy(desc(cases.updatedAt), desc(cases.id))
              .limit(1);

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
            const recentUserCases = await db
              .select({
                id: cases.id,
                conversationId: cases.conversationId,
                movementContext: cases.movementContext,
                activityType: cases.activityType,
                status: cases.status,
              })
              .from(cases)
              .where(eq(cases.userId, userId))
              .orderBy(desc(cases.updatedAt), desc(cases.id))
              .limit(12);

            const openCases = recentUserCases.filter((row) =>
              isOpenCaseStatus(row.status),
            );

            // Resolved cases are history, not blockers. Only unresolved open cases
            // are considered here, and even then only when the current problem
            // strongly looks like the same fixable issue.
            const openCasesWithLatestSignal = await Promise.all(
              openCases.map(async (row) => {
                const [latestSignal] = await db
                  .select({
                    bodyRegion: caseSignals.bodyRegion,
                    signalType: caseSignals.signalType,
                    description: caseSignals.description,
                  })
                  .from(caseSignals)
                  .where(eq(caseSignals.caseId, row.id))
                  .orderBy(desc(caseSignals.id))
                  .limit(1);

                return {
                  ...row,
                  latestSignal,
                };
              }),
            );

            const derivedMovementKey = normalizeOptionalLabel(
              derivedCaseContext.movementContext,
            );
            const derivedActivityKey = normalizeOptionalLabel(
              derivedCaseContext.activityType,
            );
            const derivedBodyRegionKey =
              normalizeOptionalLabel(derivedBodyRegion);
            const derivedSignalTypeKey =
              normalizeOptionalLabel(derivedSignalType);

            const matchedOpenCase = openCasesWithLatestSignal.find((row) => {
              const rowMovementKey = normalizeOptionalLabel(
                row.movementContext,
              );
              const rowActivityKey = normalizeOptionalLabel(row.activityType);
              const rowBodyRegionKey = normalizeOptionalLabel(
                row.latestSignal?.bodyRegion,
              );
              const rowSignalTypeKey = normalizeOptionalLabel(
                row.latestSignal?.signalType,
              );

              const sameBodyRegion =
                derivedBodyRegionKey !== "" &&
                rowBodyRegionKey !== "" &&
                derivedBodyRegionKey === rowBodyRegionKey;

              const sameSignalType =
                derivedSignalTypeKey !== "" &&
                rowSignalTypeKey !== "" &&
                derivedSignalTypeKey === rowSignalTypeKey;

              const sameStrongMovementContext =
                hasStrongCaseContext(derivedCaseContext.movementContext) &&
                hasStrongCaseContext(row.movementContext) &&
                derivedMovementKey === rowMovementKey;

              const sameStrongActivity =
                hasStrongCaseActivity(derivedCaseContext.activityType) &&
                hasStrongCaseActivity(row.activityType) &&
                derivedActivityKey === rowActivityKey;

              // Bias toward opening a new case. Only append to an existing open
              // case when it matches the same unresolved problem strongly enough
              // that the intervention path is likely the same.
              return (
                sameBodyRegion &&
                (sameStrongMovementContext ||
                  (sameStrongActivity && sameSignalType))
              );
            });

            if (matchedOpenCase) {
              await db.insert(caseSignals).values({
                userId,
                caseId: matchedOpenCase.id,
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
            );

          const isGenericSuccess =
            /glad to hear|great to hear|happy to hear|fantastic|great to see|keep it up|let me know|feel free to reach out/i.test(
              assistantText,
            );

          const hasLabels =
            /hypothesis:|guardrail:|lever:|sequence:|narrowing question:/i.test(
              assistantText,
            );

          const hasFormattedSections = /\*\*.*\*\*:/g.test(assistantText);
          const closureDrift = userSignaledClosure && /\?/.test(assistantText);

          if (
            !isValidResponse(assistantText) ||
            isWeak ||
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
          const [currentOpenCase] = await db
            .select({
              id: cases.id,
              status: cases.status,
            })
            .from(cases)
            .where(
              and(eq(cases.userId, userId), eq(cases.conversationId, convoId)),
            )
            .orderBy(desc(cases.updatedAt), desc(cases.id))
            .limit(1);

          if (currentOpenCase && isOpenCaseStatus(currentOpenCase.status)) {
            const hypothesisSentence = extractFirstMatchingSentence(finalText, [
              /\bsuggests\b/i,
              /\bindicates\b/i,
              /\bmeans\b/i,
              /\bpoints to\b/i,
              /\bpoints back to\b/i,
              /\blikely due to\b/i,
              /\bdue to\b/i,
              /\bcomes from\b/i,
              /\bis coming from\b/i,
              /\bcaused by\b/i,
              /\bis caused by\b/i,
              /\bhappening because\b/i,
              /\bthis is happening because\b/i,
              /\bthe issue is\b/i,
              /\bthe problem is\b/i,
              /\bwhat'?s going on is\b/i,
              /\bthis comes from\b/i,
              /\bthis usually comes from\b/i,
              /\bthis is driven by\b/i,
              /\bdriven by\b/i,
              /\bwhat'?s happening is\b/i,
            ]);

            if (hypothesisSentence && hypothesisSentence.trim().length > 40) {
              await db.insert(caseHypotheses).values({
                caseId: currentOpenCase.id,
                hypothesis: hypothesisSentence,
              });
            }

            const adjustmentSentence = extractFirstMatchingSentence(finalText, [
              /\bfocus on\b/i,
              /\btry\b/i,
              /\bmake sure\b/i,
              /\blet\b/i,
              /\ballow\b/i,
              /\bshift\b/i,
              /\bkeep\b/i,
              /\bthink about\b/i,
            ]);

            const hasExecutionVerb =
              adjustmentSentence != null &&
              /\b(focus|shift|load|relax|drive|keep|allow|control|rotate|stack|move|press|pull|push|hinge|brace|stabilize|stabilise)\b/i.test(
                adjustmentSentence,
              );

            if (
              adjustmentSentence &&
              adjustmentSentence.trim().length > 30 &&
              hasExecutionVerb
            ) {
              await db.insert(caseAdjustments).values({
                caseId: currentOpenCase.id,
                cue: adjustmentSentence,
                mechanicalFocus: adjustmentSentence,
              });
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

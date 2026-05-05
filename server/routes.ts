// ==============================
// IMPORTS & SETUP
// ==============================

import { BASE_NARRATIVE_V2 } from "./prompts/base_narrative_v2_claude";
import { CASE_REVIEW_NARRATIVE } from "./prompts/caseReviewNarrative";

import {
  setupAuth,
  isAuthenticated,
} from "./replit_integrations/auth/replitAuth";
import express from "express";
import cors from "cors";
import type { Express, Request, Response } from "express";
import type { Server as HTTPServer } from "http";
import { execFile, execSync } from "child_process";
import { promises as fsp } from "fs";
import path from "path";
import { promisify } from "util";

import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import { toFile } from "openai/uploads";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { eq, asc, desc, and, ne, isNull, sql, inArray } from "drizzle-orm";

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
  caseReasoningSnapshots,
  nonMechanicalSignals,
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

const execFileAsync = promisify(execFile);

process.env.PATH = `${process.env.PATH ?? ""}:/nix/store`;

function resolveFfmpegPath(): string {
  if (process.env.FFMPEG_PATH?.trim()) {
    return process.env.FFMPEG_PATH.trim();
  }

  try {
    return execSync("which ffmpeg").toString().trim() || "ffmpeg";
  } catch {
    return "ffmpeg";
  }
}

const FFMPEG_PATH = resolveFfmpegPath();

const INTERLOOP_SETTINGS_VOICE_IDS = {
  female_pilates: "VI2qcJpxMy5M6WFvpIrh",
  female_yoga: "RjWJXbF7h9KPSuGnLo5x",
  male_coach: "GwiNi5XZx3ydWAkkDpoQ",
  male_pt: "3WZjQ5NUrKH37Zw6Vgp7",
} as const;

const CONVERSATION_SESSION_TIMEOUT_MS = 1000 * 60 * 60 * 6;

type PersistedInterloopVoice = keyof typeof INTERLOOP_SETTINGS_VOICE_IDS;

// ==============================
// PROFILE IMAGE FILE SYSTEM PATHS
// ==============================

const PROFILE_IMAGE_URL_PREFIX = "/uploads/profile-images";
const UPLOADS_ROOT_DIR = path.resolve(process.cwd(), "uploads");
const PROFILE_IMAGES_DIR = path.join(UPLOADS_ROOT_DIR, "profile-images");

async function ensureProfileImagesDirectory(): Promise<void> {
  try {
    await fsp.mkdir(PROFILE_IMAGES_DIR, { recursive: true });
  } catch (err) {
    console.error("Failed to ensure profile images directory:", err);
  }
}

// ==============================
// UTILITY: TEXT CLAMP
// ==============================

function clampText(s: string, max = 800): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function createLayer1TraceId(): string {
  return `l1_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function logLayer1Trace(
  traceId: string | null | undefined,
  step: string,
  payload: Record<string, unknown> = {},
): void {
  if (!traceId) return;

  console.log("LAYER1_TRACE", {
    traceId,
    step,
    ...payload,
  });
}

function normalizeStoredFirstName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /^null$/i.test(trimmed)) return null;
  return trimmed;
}

function normalizeStoredProfileImageUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || /^null$/i.test(trimmed)) return "";
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
  profileImageUrl: string;
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
  profileImageUrl?: unknown,
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
    profileImageUrl: normalizeStoredProfileImageUrl(profileImageUrl),
  };
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value == null) return false;

  if (typeof value === "string") {
    return value.trim() !== "";
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value === "boolean") {
    return value === true;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasMeaningfulValue(item));
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      hasMeaningfulValue(item),
    );
  }

  return false;
}

function hasDurableMemoryEvidence(
  memory: Awaited<ReturnType<typeof getMemory>>,
): boolean {
  const memoryRecord = memory as unknown as Record<string, unknown>;

  return Object.entries(memoryRecord).some(([key, value]) => {
    if (key === "identity") return false;
    if (key === "sportContext") return false;
    if (key === "preferences") return false;

    return hasMeaningfulValue(value);
  });
}

function hasMeaningfulConversationHistory(
  storedMessages: Array<{ role?: string | null; content?: string | null }>,
): boolean {
  const meaningfulMessages = storedMessages.filter((message) => {
    const content = String(message.content ?? "").trim();
    if (!content) return false;
    if (content.length < 20) return false;

    return message.role === "user" || message.role === "assistant";
  });

  const hasAssistantContext = meaningfulMessages.some(
    (message) => message.role === "assistant",
  );

  return meaningfulMessages.length >= 3 || hasAssistantContext;
}

function buildSettingsContextBlock(
  settings: PersistedInterloopSettings,
): string {
  const lines: string[] = [];

  if (settings.primaryActivity) {
    lines.push(`Primary activity: ${settings.primaryActivity}`);
  }

  if (settings.activityLevel) {
    lines.push(`Activity level: ${settings.activityLevel}`);
  }

  if (settings.competitionLevel) {
    lines.push(`Competition level: ${settings.competitionLevel}`);
  }

  if (settings.dominantHand) {
    lines.push(`Dominant hand: ${settings.dominantHand}`);
  }

  const bodyProfile = [
    settings.age ? `age ${settings.age}` : "",
    settings.height ? `height ${settings.height}` : "",
    settings.weight ? `weight ${settings.weight}` : "",
  ].filter(Boolean);

  if (bodyProfile.length > 0) {
    lines.push(`Body profile: ${bodyProfile.join(", ")}`);
  }

  if (lines.length === 0) return "";

  return `
=== PERSISTENT USER SETTINGS CONTEXT ===
These are stable user-provided profile settings.

Use these settings as durable interpretive context across the user's lifetime.
They should shape how you read relevant activity demands, body profile, dominant side, load, sport/activity context, and movement signals.

Settings are not case evidence.
Settings do not prove a current mechanism.
Settings do not override the current user signal.
Settings do not create or imply a case by themselves.
Settings are not discovered findings.

They are an always-available profile anchor for interpreting the user's current message when relevant.

${lines.join("\n")}
`;
}

function buildSettingsInitializationEmphasisBlock(
  shouldUseSettingsInitialization: boolean,
): string {
  if (!shouldUseSettingsInitialization) return "";

  return `
=== NEW USER SETTINGS EMPHASIS ===
This appears to be an early conversation for this user.

Use the persistent settings context more actively to orient the first few interpretations and make the opening investigation specific to the user's profile.

Do not treat settings as proof of a mechanism.
Do not create or imply a case from settings alone.
Current user signals still control the investigation.
`;
}

function isTrueNewUserForInitialization({
  resolvedActiveCase,
  memory,
  storedMessages,
}: {
  resolvedActiveCase: unknown;
  memory: Awaited<ReturnType<typeof getMemory>>;
  storedMessages: Array<{ role?: string | null; content?: string | null }>;
}): boolean {
  if (resolvedActiveCase) return false;
  if (hasDurableMemoryEvidence(memory)) return false;
  if (hasMeaningfulConversationHistory(storedMessages)) return false;

  return true;
}

// ==============================
// DOMAIN BOUNDARY: MEDICAL / SYSTEMIC / INTERNAL-SYMPTOM DETECTION
// ==============================

const MEDICAL_CHEST_VISCERAL_PATTERNS: RegExp[] = [
  /\bchest pain\b/i,
  /\bpain in (?:my )?chest\b/i,
  /\btightness in (?:my )?chest\b/i,
  /\bpressure in (?:my )?chest\b/i,
  /\bheaviness in (?:my )?chest\b/i,
  /\bsolar plexus\b/i,
  /\besophagus\b|\besophageal\b/i,
  /\bdiaphragm (?:pain|spasm|cramp|cramping|tightness)\b/i,
  /\binternal (?:pain|burning|tearing|pressure)\b/i,
  /\bdeep (?:inside|internal) (?:pain|burning|ache)\b/i,
  /\bbehind (?:my )?(?:sternum|breastbone|ribs)\b/i,
  /\bheart (?:pain|racing|pounding|palpitations)\b/i,
  /\bpalpitations\b/i,
  /\bracing heart\b|\bheart (?:is )?racing\b/i,
  /\babdominal pain\b|\bpain in (?:my )?(?:abdomen|stomach|belly|gut)\b/i,
  /\bstomach (?:pain|ache|cramp|cramping)\b/i,
  /\b(?:kidney|liver|gallbladder|bladder|pancreas|spleen|intestine|bowel) (?:pain|ache)\b/i,
];

const MEDICAL_REFLUX_GI_PATTERNS: RegExp[] = [
  /\breflux\b/i,
  /\bheartburn\b/i,
  /\bacid (?:reflux|coming up|in my throat|in my chest)\b/i,
  /\bregurgitat/i,
  /\bburning (?:in (?:my )?(?:chest|throat|esophagus|stomach))\b/i,
  /\bsour (?:taste|liquid) in (?:my )?(?:mouth|throat)\b/i,
  /\bindigestion\b/i,
  /\bvomit/i,
  /\bthrowing up\b|\bthrew up\b/i,
  /\bdiarrhea\b/i,
  /\bbowel (?:pain|cramp|cramping|issue|issues)\b/i,
];

const MEDICAL_SYSTEMIC_PATTERNS: RegExp[] = [
  /\bnausea\b|\bnauseous\b|\bnauseated\b/i,
  /\bsalivat/i,
  /\bwoozy\b/i,
  /\bdizzy\b|\bdizziness\b/i,
  /\blightheaded\b|\blight-headed\b|\blight headed\b/i,
  /\bfaint(?:ing|ed)?\b/i,
  /\bpassing out\b|\bpassed out\b|\bblacked out\b|\bblack(?:ing)? out\b/i,
  /\bsweating (?:profusely|a lot|cold)\b|\bcold sweat/i,
  /\bclammy\b/i,
  /\bshort(?:ness)? of breath\b|\bcan'?t (?:catch my )?breathe?\b|\btrouble breathing\b|\bhard to breathe\b/i,
  /\bchills\b/i,
  /\bfever\b|\bfeverish\b/i,
  /\bnight sweats\b/i,
  /\btingling (?:in|down) (?:my )?(?:arm|arms|jaw|face)\b/i,
  /\bnumbness (?:in|down) (?:my )?(?:arm|arms|jaw|face)\b/i,
  /\bradiating (?:to|into|down) (?:my )?(?:jaw|arm|arms|neck)\b/i,
];

const MEDICAL_NOCTURNAL_PATTERNS: RegExp[] = [
  /\bwoke me up\b/i,
  /\bwoke up with\b/i,
  /\bwoken (?:up )?by\b/i,
  /\bduring (?:the night|sleep)\b/i,
  /\bin (?:my|the middle of) sleep\b/i,
  /\bin the middle of the night\b/i,
  /\bwhile (?:i was )?(?:sleeping|asleep)\b/i,
];

function hasMedicalSystemicCoreSignal(text: string): boolean {
  const input = String(text ?? "").trim();
  if (!input) return false;

  const normalized = input.toLowerCase().replace(/\s+/g, " ");

  const coreGroups: RegExp[][] = [
    MEDICAL_CHEST_VISCERAL_PATTERNS,
    MEDICAL_REFLUX_GI_PATTERNS,
    MEDICAL_SYSTEMIC_PATTERNS,
  ];

  for (const group of coreGroups) {
    for (const pattern of group) {
      if (pattern.test(normalized)) {
        return true;
      }
    }
  }

  return false;
}

function hasNocturnalMedicalContext(text: string): boolean {
  const input = String(text ?? "").trim();
  if (!input) return false;

  const normalized = input.toLowerCase().replace(/\s+/g, " ");

  for (const pattern of MEDICAL_NOCTURNAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

function isMedicalSystemicSignal(text: string): boolean {
  return hasMedicalSystemicCoreSignal(text);
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

type UploadedMultipartFile = {
  filename: string;
  contentType: string;
  buffer: Buffer;
};

function parseMultipartHeaderValue(value: string): Record<string, string> {
  const parts = value.split(";").map((part) => part.trim());
  const parsed: Record<string, string> = {};

  for (const part of parts) {
    const [rawKey, ...rawValueParts] = part.split("=");
    const key = rawKey?.trim();

    if (!key || rawValueParts.length === 0) continue;

    const rawValue = rawValueParts.join("=").trim();
    parsed[key] = rawValue.replace(/^"|"$/g, "");
  }

  return parsed;
}

function extractMultipartBoundary(
  contentType: string | undefined,
): string | null {
  if (!contentType) return null;

  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] ?? match?.[2]?.trim() ?? null;
}

async function readMultipartProfileImage(
  req: Request,
): Promise<UploadedMultipartFile | null> {
  const contentType = req.headers["content-type"];
  const boundary = extractMultipartBoundary(
    Array.isArray(contentType) ? contentType[0] : contentType,
  );

  if (!boundary) return null;

  const chunks: Buffer[] = [];
  let totalSize = 0;
  const maxRequestSize = 2 * 1024 * 1024 + 1024 * 256;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buffer.length;

    if (totalSize > maxRequestSize) {
      throw new Error("FILE_TOO_LARGE");
    }

    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks);
  const boundaryText = `--${boundary}`;
  const parts = body.toString("binary").split(boundaryText);

  for (const rawPart of parts) {
    if (!rawPart || rawPart === "--" || rawPart === "--\r\n") continue;

    const headerEndIndex = rawPart.indexOf("\r\n\r\n");
    if (headerEndIndex === -1) continue;

    const rawHeaders = rawPart.slice(0, headerEndIndex).trim();
    let rawContent = rawPart.slice(headerEndIndex + 4);

    if (rawContent.endsWith("\r\n")) {
      rawContent = rawContent.slice(0, -2);
    }

    if (rawContent.endsWith("--")) {
      rawContent = rawContent.slice(0, -2);
    }

    const dispositionLine = rawHeaders
      .split("\r\n")
      .find((line) => /^content-disposition:/i.test(line));
    const typeLine = rawHeaders
      .split("\r\n")
      .find((line) => /^content-type:/i.test(line));

    if (!dispositionLine) continue;

    const dispositionValue = dispositionLine.replace(
      /^content-disposition:\s*/i,
      "",
    );
    const disposition = parseMultipartHeaderValue(dispositionValue);

    if (disposition.name !== "file") continue;

    const filename = disposition.filename ?? "";
    const fileContentType = typeLine
      ? typeLine
          .replace(/^content-type:\s*/i, "")
          .trim()
          .toLowerCase()
      : "";

    return {
      filename,
      contentType: fileContentType,
      buffer: Buffer.from(rawContent, "binary"),
    };
  }

  return null;
}

function getProfileImageExtension(
  file: UploadedMultipartFile,
): "jpg" | "png" | null {
  const filename = file.filename.toLowerCase();
  const contentType = file.contentType.toLowerCase();

  if (
    contentType === "image/jpeg" ||
    contentType === "image/jpg" ||
    filename.endsWith(".jpg") ||
    filename.endsWith(".jpeg")
  ) {
    return "jpg";
  }

  if (contentType === "image/png" || filename.endsWith(".png")) {
    return "png";
  }

  return null;
}

function sanitizePathSegment(value: string): string {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 128);
}

async function uploadProfileImageToStorage(
  userId: string,
  filename: string,
  buffer: Buffer,
  _contentType: string,
): Promise<string> {
  const safeUserId = sanitizePathSegment(userId) || "user";
  const safeFilename = sanitizePathSegment(filename) || `profile-${Date.now()}`;

  const userDir = path.join(PROFILE_IMAGES_DIR, safeUserId);
  await fsp.mkdir(userDir, { recursive: true });

  const fullPath = path.join(userDir, safeFilename);
  await fsp.writeFile(fullPath, buffer);

  return `${PROFILE_IMAGE_URL_PREFIX}/${encodeURIComponent(
    safeUserId,
  )}/${encodeURIComponent(safeFilename)}`;
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

function normalizeLifecycleMessage(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
}

function stripLeadingGreeting(text: string): string {
  return text
    .trim()
    .replace(
      /^(?:hi|hey|hello|good morning|good afternoon|good evening|how are you|what's up|whats up|sup)\b[\s,!.?;-]*/i,
      "",
    )
    .trim();
}

function isGreetingOpeningMessage(text: string): boolean {
  const normalized = normalizeLifecycleMessage(text);
  if (!normalized) return false;

  const greetingOnly =
    /^(?:hi|hey|hello|good morning|good afternoon|good evening|how are you|how are you doing|what's up|whats up|sup)[\s,!.?]*$/i;

  const greetingLed =
    /^(?:hi|hey|hello|good morning|good afternoon|good evening|how are you|how are you doing|what's up|whats up|sup)\b/i;

  return greetingOnly.test(normalized) || greetingLed.test(normalized);
}

function dependsOnPriorConversationContext(text: string): boolean {
  const normalized = normalizeLifecycleMessage(text);
  if (!normalized) return false;

  const withoutGreeting = normalizeLifecycleMessage(stripLeadingGreeting(text));
  const candidates = [normalized, withoutGreeting].filter(Boolean);

  const dependencyPatterns = [
    /\byou said\b/i,
    /\byou mentioned\b/i,
    /\blike you said\b/i,
    /\bwhat you said\b/i,
    /\bthat thing you said\b/i,
    /\bthat adjustment\b/i,
    /\bthat cue\b/i,
    /\bthat drill\b/i,
    /\bthat test\b/i,
    /\bthat worked\b/i,
    /\bthis worked\b/i,
    /\bit worked\b/i,
    /\bthat helped\b/i,
    /\bthis helped\b/i,
    /\bi tried\b/i,
    /\bi did that\b/i,
    /\bi did it\b/i,
    /\bafter i tried it\b/i,
    /\bafter trying it\b/i,
    /\bafter i did that\b/i,
    /\bwhen i did that\b/i,
    /\bwhen i tried it\b/i,
    /\bthat makes sense\b/i,
    /\bthis makes sense\b/i,
    /\bexactly\b/i,
    /^(?:yes|yeah|yep|no|nah),?\s+but\b/i,
    /^(?:yes|yeah|yep|no|nah),?\s+(?:and|that|this|it)\b/i,
    /\bstill\s+(?:hurts|feels|happens|there|doing|getting|having|not|is|isn't|does|doesn't|can't|cannot)\b/i,
    /\bsame\s+(?:thing|issue|problem|spot|pain|feeling|side)\b/i,
    /\bagain\s+(?:when|after|with|during|on|in)\b/i,
    /\bbefore\s+(?:like|when|after|you|that|this|it)\b/i,
  ];

  return candidates.some((candidate) =>
    dependencyPatterns.some((pattern) => pattern.test(candidate)),
  );
}

function isFreshSessionOpener(text: string): boolean {
  const normalized = normalizeLifecycleMessage(text);
  if (!normalized) return false;
  if (dependsOnPriorConversationContext(text)) return false;

  const hasGreeting = isGreetingOpeningMessage(text);
  const withoutGreeting = normalizeLifecycleMessage(stripLeadingGreeting(text));
  const openerText = withoutGreeting || normalized;

  const explicitFreshPatterns = [
    /\bdifferent thing\b/i,
    /\bsomething else\b/i,
    /\bsomething different\b/i,
    /\bnew issue\b/i,
    /\bnew problem\b/i,
    /\banother thing\b/i,
    /\banother issue\b/i,
    /\bswitching gears\b/i,
    /\bcan we talk about\b/i,
    /\bnow i want to talk about\b/i,
    /\blet'?s work on\b/i,
    /\bi need help with\b/i,
    /\bi want to work on\b/i,
    /\bi want to talk about\b/i,
    /\bcan you help me with\b/i,
    /\bcan we work on\b/i,
  ];

  if (explicitFreshPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const standaloneOpeningPatterns = [
    /^(?:i need help|i need some help|can you help|need help)\b/i,
    /^(?:i have|i've got|ive got)\s+(?:a|an|this|some|another|new)?\s*(?:issue|problem|question|thing)\b/i,
    /^(?:my|the)\s+\w+(?:\s+\w+){0,5}\s+(?:hurts|is hurting|feels|keeps|started|has been)\b/i,
    /^(?:today|lately|recently)\b.*\b(?:hurts|pain|tight|issue|problem|feels off|not right|help|started hurting)\b/i,
  ];

  if (standaloneOpeningPatterns.some((pattern) => pattern.test(openerText))) {
    return true;
  }

  if (
    hasGreeting &&
    openerText &&
    explicitFreshPatterns.some((pattern) => pattern.test(openerText))
  ) {
    return true;
  }

  return false;
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
    { label: "serve mechanics", regex: /\b(?:serve|serving)\b/i },
    { label: "swing mechanics", regex: /\bswing(?:ing)?\b/i },

    { label: "golf swing", regex: /\bgolf\b|\bgolf swing\b|\bback nine\b/i },
    { label: "tee shot", regex: /\btee shot\b/i },

    {
      label: "getting out of car",
      regex:
        /\b(?:getting|got|get) out of (?:the |my )?car\b|\bgetting out of (?:the )?vehicle\b/i,
    },
    {
      label: "getting into car",
      regex: /\b(?:getting|got|get) (?:in|into) (?:the |my )?car\b/i,
    },
    {
      label: "getting out of bed",
      regex:
        /\b(?:getting|got|get) out of (?:the |my )?bed\b|\bgetting up from bed\b/i,
    },
    {
      label: "getting up from chair",
      regex:
        /\b(?:getting|got|get) up from (?:the |my |a )?(?:chair|seat)\b|\bstanding up from (?:the |my |a )?(?:chair|seat)\b/i,
    },

    {
      label: "waking up",
      regex:
        /\bwaking up (?:stiff|sore|tight|with)\b|\bwake up (?:stiff|sore|tight|with)\b|\bwoken up (?:stiff|sore|tight)\b/i,
    },
    {
      label: "after sleeping",
      regex:
        /\bafter (?:i )?(?:slept|sleep|sleeping)\b|\bafter sleeping (?:flat|on (?:my )?(?:back|side|stomach))\b/i,
    },
    {
      label: "desk work",
      regex:
        /\b(?:at|on|during) (?:my |the )?(?:desk|computer|laptop)\b|\bdesk work\b|\bworking at (?:my |a |the )?(?:desk|computer|laptop)\b|\bat the computer\b/i,
    },
    {
      label: "chair sitting",
      regex:
        /\bchair (?:height|position|posture)\b|\bseat (?:height|position|posture)\b|\bin (?:my |the |a )?chair\b/i,
    },
    {
      label: "driving",
      regex:
        /\bwhile (?:i am |i'm )?driving\b|\bon the drive\b|\bduring the drive\b|\bdriving to\b|\bdriving home\b|\bdriving for\b/i,
    },
    {
      label: "sitting",
      regex:
        /\bwhile (?:i am |i'm )?sitting\b|\bwhen (?:i am |i'm )?sitting\b|\bafter sitting\b|\bsitting for\b|\bsitting upright\b/i,
    },
    {
      label: "sleeping",
      regex:
        /\bwhile (?:i am |i'm )?sleeping\b|\bin my sleep\b|\bsleeping flat\b|\bsleeping on (?:my )?(?:back|side|stomach)\b/i,
    },
    {
      label: "lying flat",
      regex: /\blying flat\b|\blaying flat\b|\bflat on (?:my )?back\b/i,
    },
    {
      label: "on couch",
      regex: /\bon (?:the |my )?couch\b|\bon (?:the |my )?sofa\b/i,
    },
    {
      label: "in bed",
      regex: /\bin (?:my |the )?bed\b|\bin bed\b/i,
    },

    {
      label: "during workout",
      regex:
        /\bduring (?:my |a |the )?(?:workout|training|session|lift|practice)\b/i,
    },
    {
      label: "after training",
      regex:
        /\bafter (?:my |a |the )?(?:workout|training|session|lift|practice)\b/i,
    },
  ];

  return (
    directContextPatterns.find((pattern) => pattern.regex.test(input))?.label ??
    null
  );
}

function normalizeExtractedContextCandidate(
  candidate: string | null | undefined,
): string | null {
  const raw = String(candidate ?? "").trim();
  if (!raw) return null;

  const compactFromFragment = buildCompactMovementContext(raw);
  if (compactFromFragment) return compactFromFragment;

  const expanded = `while I am ${raw}`;
  const compactFromExpanded = buildCompactMovementContext(expanded);
  if (compactFromExpanded) return compactFromExpanded;

  const lowered = raw.toLowerCase();
  const anatomyOnlyPatterns = [
    /\bright side\b/i,
    /\bleft side\b/i,
    /\blower back\b/i,
    /\blow back\b/i,
    /\bpain\b/i,
    /\btweak\b/i,
  ];

  if (anatomyOnlyPatterns.some((pattern) => pattern.test(lowered))) {
    return null;
  }

  const fallbackPatterns: Array<{ label: string; regex: RegExp }> = [
    { label: "desk work", regex: /\b(?:desk|computer|laptop)\b/i },
    { label: "chair sitting", regex: /\bchair\b|\bseat\b/i },
    { label: "driving", regex: /\bdriv(?:e|ing|en)\b|\bcar\b/i },
    { label: "sleeping", regex: /\bsleep(?:ing)?\b|\basleep\b|\bbed\b/i },
    {
      label: "sitting",
      regex: /\bsit(?:ting)?\b|\bseated\b|\bcouch\b|\bsofa\b/i,
    },
    {
      label: "during workout",
      regex:
        /\bworkout\b|\btraining\b|\bsession\b|\bpractice\b|\blift(?:ing)?\b/i,
    },
    { label: "golf swing", regex: /\bgolf\b/i },
    { label: "serve mechanics", regex: /\bserve\b|\bserving\b/i },
    { label: "swing mechanics", regex: /\bswing(?:ing)?\b/i },
    { label: "rotation", regex: /\brotat(?:e|ing|ion)\b|\bturning\b/i },
    { label: "hinge", regex: /\bhing(?:e|ing)\b/i },
    { label: "reach", regex: /\breach(?:ing)?\b/i },
    { label: "squat", regex: /\bsquat(?:ting)?\b/i },
    { label: "deadlift", regex: /\bdeadlift(?:ing)?\b/i },
    { label: "lunge", regex: /\blunge(?:s|ing)?\b/i },
    { label: "running", regex: /\brun(?:ning)?\b|\bjog(?:ging)?\b/i },
    { label: "walking", regex: /\bwalk(?:ing)?\b/i },
    { label: "cycling", regex: /\bcycl(?:e|ing)\b|\bbik(?:e|ing)\b/i },
  ];

  for (const entry of fallbackPatterns) {
    if (entry.regex.test(lowered)) {
      return entry.label;
    }
  }

  const cleanedFragment = raw
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.!?-]+|[\s,;:.!?-]+$/g, "")
    .trim();

  if (!cleanedFragment) return null;

  return clampText(cleanedFragment, 60);
}

function deriveSettingsActivityHint(
  settings?: PersistedInterloopSettings | null,
): string | null {
  if (!settings) return null;

  const primary = normalizeSettingsText(settings.primaryActivity).toLowerCase();
  if (!primary) return null;

  const mapping: Array<{ label: string; regex: RegExp }> = [
    { label: "racquetball", regex: /racquetball/i },
    { label: "tennis", regex: /\btennis\b/i },
    { label: "pickleball", regex: /\bpickleball\b/i },
    { label: "squash", regex: /\bsquash\b/i },
    { label: "badminton", regex: /\bbadminton\b/i },
    { label: "golf", regex: /\bgolf\b/i },
    { label: "running", regex: /\brun(?:ning)?\b/i },
    { label: "walking", regex: /\bwalk(?:ing)?\b/i },
    { label: "cycling", regex: /\bcycling\b|\bbiking\b|\bbike\b/i },
    { label: "swimming", regex: /\bswim(?:ming)?\b/i },
    { label: "lifting", regex: /\blift(?:ing)?\b|\bweightlift/i },
    { label: "crossfit", regex: /\bcrossfit\b/i },
    { label: "pilates", regex: /\bpilates\b/i },
    { label: "yoga", regex: /\byoga\b/i },
    { label: "climbing", regex: /\bclimb(?:ing)?\b/i },
    { label: "rowing", regex: /\brow(?:ing)?\b/i },
    { label: "basketball", regex: /\bbasketball\b/i },
    { label: "soccer", regex: /\bsoccer\b|\bfootball\b/i },
    { label: "baseball", regex: /\bbaseball\b/i },
    { label: "hockey", regex: /\bhockey\b/i },
    {
      label: "martial arts",
      regex:
        /\bmartial arts\b|\bmma\b|\bbjj\b|\bkarate\b|\bjudo\b|\btaekwondo\b/i,
    },
    { label: "boxing", regex: /\bboxing\b|\bkickboxing\b/i },
    { label: "dance", regex: /\bdanc(?:e|ing)\b|\bballet\b/i },
    { label: "training", regex: /\btraining\b|\bworkout\b|\bgym\b/i },
  ];

  for (const entry of mapping) {
    if (entry.regex.test(primary)) {
      return entry.label;
    }
  }

  const compact = primary.replace(/\s+/g, " ").trim();
  if (compact && compact.length <= 24) {
    return compact;
  }

  return null;
}

function hasAnyActivitySignalInMessage(text: string): boolean {
  const input = text.trim();
  if (!input) return false;

  if (buildCompactMovementContext(input)) return true;

  return /\b(?:racquetball|tennis|pickleball|squash|badminton|golf|run|running|jog|jogging|walk|walking|cycl(?:e|ing)|bike|biking|swim|swimming|lift|lifting|weightlift|crossfit|pilates|yoga|climb|climbing|row|rowing|basketball|soccer|football|baseball|hockey|martial arts|boxing|kickboxing|danc(?:e|ing)|ballet|squat|deadlift|lunge|serve|serving|swing|swinging|forehand|backhand|backswing|contact point|rotate|rotation|turning|hinge|hinging|reach|reaching|workout|training|practice|gym|session|sit|sitting|sat|seat|seated|chair|desk|computer|laptop|driv(?:e|ing|en)|sleep|sleeping|slept|asleep|bed|couch|sofa|waking|wake|woken|posture)\b/i.test(
    input,
  );
}

function hasExplicitActivityInText(text: string): boolean {
  return /\b(?:racquetball|tennis|pickleball|squash|badminton|golf|run|running|jog|jogging|walk|walking|cycle|cycling|bike|biking|swim|swimming|lift|lifting|weightlift|crossfit|pilates|yoga|climb|climbing|row|rowing|basketball|soccer|football|baseball|hockey|martial arts|boxing|kickboxing|dance|dancing|ballet|squat|deadlift|lunge)\b/i.test(
    text.trim(),
  );
}

function deriveCaseContext(
  text: string,
  settings?: PersistedInterloopSettings | null,
): {
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
    { label: "tennis", regex: /\btennis\b/i },
    { label: "pickleball", regex: /\bpickleball\b/i },
    { label: "squash", regex: /\bsquash\b/i },
    { label: "badminton", regex: /\bbadminton\b/i },

    { label: "golf", regex: /\bgolf\b|\bgolf swing\b|\btee shot\b/i },

    { label: "running", regex: /\brun(?:ning)?\b|\bjog(?:ging)?\b/i },
    { label: "walking", regex: /\bwalk(?:ing)?\b/i },
    { label: "cycling", regex: /\bcycl(?:e|ing)\b|\bbik(?:e|ing)\b/i },
    { label: "swimming", regex: /\bswim(?:ming)?\b/i },
    { label: "rowing", regex: /\brow(?:ing)?\b/i },
    { label: "climbing", regex: /\bclimb(?:ing)?\b/i },

    { label: "squat", regex: /\bsquat(?:ting)?\b/i },
    { label: "deadlift", regex: /\bdeadlift(?:ing)?\b/i },
    { label: "lunge", regex: /\blunge(?:s|ing)?\b/i },
    { label: "lifting", regex: /\blift(?:ing)?\b|\bweightlift/i },
    { label: "crossfit", regex: /\bcrossfit\b/i },

    { label: "pilates", regex: /\bpilates\b/i },
    { label: "yoga", regex: /\byoga\b/i },

    { label: "basketball", regex: /\bbasketball\b/i },
    { label: "soccer", regex: /\bsoccer\b/i },
    { label: "baseball", regex: /\bbaseball\b/i },
    { label: "hockey", regex: /\bhockey\b/i },
    {
      label: "martial arts",
      regex:
        /\bmartial arts\b|\bmma\b|\bbjj\b|\bkarate\b|\bjudo\b|\btaekwondo\b/i,
    },
    { label: "boxing", regex: /\bboxing\b|\bkickboxing\b/i },
    { label: "dance", regex: /\bdanc(?:e|ing)\b|\bballet\b/i },

    { label: "training", regex: /\btraining\b|\bworkout\b|\bgym\b/i },

    {
      label: "driving",
      regex:
        /\bdriv(?:e|ing|en)\b|\bon the drive\b|\bin (?:the |my )?car\b|\bgetting out of (?:the |my )?car\b|\bgetting (?:in|into) (?:the |my )?car\b/i,
    },
    {
      label: "desk work",
      regex:
        /\b(?:at|on|during) (?:my |the )?(?:desk|computer|laptop)\b|\bdesk work\b|\bworking at (?:my |a |the )?(?:desk|computer|laptop)\b|\bat the computer\b/i,
    },
    {
      label: "sitting",
      regex:
        /\bsit(?:ting)?\b|\bseated\b|\bseat (?:height|position|posture)\b|\bchair (?:height|position|posture)\b|\bin (?:my |the |a )?chair\b|\bon (?:the |my )?couch\b|\bon (?:the |my )?sofa\b/i,
    },
    {
      label: "sleeping",
      regex:
        /\bsleep(?:ing)?\b|\basleep\b|\bslept\b|\bin (?:my |the )?bed\b|\bwaking up\b|\bwake up\b|\bwoken up\b|\blying flat\b|\blaying flat\b|\bflat on (?:my )?back\b/i,
    },

    { label: "serve", regex: /\bserve\b|\bserving\b/i },
    { label: "swing", regex: /\bswing\b|\bswinging\b/i },
    { label: "rotation", regex: /\brotate|rotation|turning\b/i },
    { label: "hinge", regex: /\bhinge|hinging\b/i },
    { label: "reach", regex: /\breach|reaching\b/i },
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
      const normalized = normalizeExtractedContextCandidate(candidate);
      if (normalized) {
        movementContext = normalized;
      }
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

  if (detectedActivity === "golf") {
    movementContext = "golf swing";
  }

  if (
    isRacquetballContext &&
    normalizeExtractedContextCandidate(movementContext) === null
  ) {
    movementContext = "drive serve";
  }

  if (
    !movementContext &&
    normalizedInput.includes("leaning forward") &&
    (normalizedInput.includes("serve") || detectedActivity === "racquetball")
  ) {
    movementContext = "serve lean forward";
  }

  let finalActivity = detectedActivity;

  if (
    finalActivity === "unspecified" &&
    !hasAnyActivitySignalInMessage(input)
  ) {
    const settingsActivityHint = deriveSettingsActivityHint(settings);
    if (settingsActivityHint) {
      finalActivity = settingsActivityHint;
      if (!movementContext) {
        movementContext = settingsActivityHint;
      }
    }
  }

  if (!movementContext) {
    movementContext = "general movement";
  }

  return {
    movementContext: clampText(movementContext, 80),
    activityType: finalActivity,
  };
}

function deriveBodyRegion(text: string): string | null {
  const input = text.trim();

  const regionPatterns: Array<{ label: string; regex: RegExp }> = [
    {
      label: "low back",
      regex:
        /\blower[-\s]?right back\b|\bright lower back\b|\blower right side of (?:my |the )?back\b|\bright side low back\b|\bright side and back\b|\blower back right side\b|\blow back\b|\blower back\b|\blumbar\b/i,
    },
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

type SignalLaneClassification = {
  lane: "mechanical" | "non_mechanical" | "unclear";
  category?: string;
  safetyRelevant?: boolean;
};

function getMovementFatigueRouting(text: string): {
  isFatigueSignal: boolean;
  hasMovementContext: boolean;
  isMovementContextFatigue: boolean;
} {
  const input = String(text ?? "").trim();
  if (!input) {
    return {
      isFatigueSignal: false,
      hasMovementContext: false,
      isMovementContextFatigue: false,
    };
  }

  const isFatigueSignal =
    /\b(?:fatigue|fatigued|tired|stamina|endurance|muscle load|burn|heavy legs|legs? (?:get|gets|getting|got|are|is|feel|feels|felt) tired|legs? (?:get|gets|getting|got|are|is|feel|feels|felt) fatigued)\b/i.test(
      input,
    );
  const hasMovementContext =
    /\b(?:racquetball|game|games|match|matches|serve|serves|swing|shot|shots|footwork|movement|mechanics|knee|knees|hip|hips|shoulder|shoulders|leg|legs|quad|quads|hamstring|hamstrings|calf|calves|ribs?|pelvis|stacked|posture|load|loading|rotation|rotate|bend|bending|step|push|cut|sprint|lateral|overhead|reps?|sets?|repeated)\b/i.test(
      input,
    );

  return {
    isFatigueSignal,
    hasMovementContext,
    isMovementContextFatigue: isFatigueSignal && hasMovementContext,
  };
}

function isMovementContextFatigueSignal(text: string): boolean {
  return getMovementFatigueRouting(text).isMovementContextFatigue;
}

function classifySignalLane(userText: string): SignalLaneClassification {
  const t = (userText || "").toLowerCase();

  if (isMovementContextFatigueSignal(userText)) {
    return { lane: "mechanical", safetyRelevant: false };
  }

  const categoryChecks: Array<{
    category: string;
    safetyRelevant: boolean;
    regex: RegExp;
  }> = [
    {
      category: "appetite_change",
      safetyRelevant: true,
      regex:
        /\b(?:not hungry|no appetite|loss of appetite|lost my appetite|haven'?t been hungry|have not been hungry|don'?t feel hungry|do not feel hungry|not eating)\b/i,
    },
    {
      category: "taste_change",
      safetyRelevant: true,
      regex:
        /\b(?:nothing tastes good|taste(?:s)? (?:bad|off|different|weird)|loss of taste|lost my taste|can'?t taste|cannot taste|food tastes)\b/i,
    },
    {
      category: "dizziness",
      safetyRelevant: true,
      regex: /\b(?:dizzy|dizziness|lightheaded|light-headed|vertigo|faint)\b/i,
    },
    {
      category: "medication_effect",
      safetyRelevant: true,
      regex:
        /\b(?:medication|medicine|meds|prescription|side effect|new dose|dosage)\b/i,
    },
    {
      category: "illness",
      safetyRelevant: true,
      regex:
        /\b(?:fever|sick|ill|illness|infection|nausea|vomit|cough|flu|covid)\b/i,
    },
    {
      category: "mood",
      safetyRelevant: true,
      regex:
        /\b(?:depressed|depression|anxious|anxiety|hopeless|panic|mood)\b/i,
    },
    {
      category: "sleep",
      safetyRelevant: false,
      regex:
        /\b(?:can'?t sleep|cannot sleep|haven'?t been sleeping|have not been sleeping|not sleeping|insomnia|sleeping poorly|sleep has been)\b/i,
    },
    {
      category: "fatigue",
      safetyRelevant: false,
      regex:
        /\b(?:tired all the time|fatigue|fatigued|exhausted|wiped out|low energy)\b/i,
    },
    {
      category: "hydration",
      safetyRelevant: false,
      regex:
        /\b(?:dehydrated|dehydration|thirsty|dry mouth|not drinking enough|haven'?t been drinking)\b/i,
    },
    {
      category: "general_health",
      safetyRelevant: true,
      regex:
        /\b(?:weight loss|losing weight|night sweats|appetite|taste|weakness all over|feel unwell)\b/i,
    },
  ];

  const matched = categoryChecks.find((entry) => entry.regex.test(t));
  if (matched) {
    return {
      lane: "non_mechanical",
      category: matched.category,
      safetyRelevant: matched.safetyRelevant,
    };
  }

  if (qualifiesForTimelineSignal(userText)) {
    return { lane: "mechanical", safetyRelevant: false };
  }

  return { lane: "unclear", safetyRelevant: false };
}

function buildNonMechanicalSignalResponse(
  classification: SignalLaneClassification,
): string {
  if (
    classification.category === "appetite_change" ||
    classification.category === "taste_change"
  ) {
    return "Loss of appetite and taste changes aren’t something I’d treat as a movement mechanics issue. Because that can come from medical, medication, nutrition, dental, or illness-related causes, it’s worth bringing up with a doctor, especially if it’s new or persistent.\n\nHow long has this been going on, and have you noticed any weight loss, weakness, dizziness, fever, or recent medication changes?";
  }

  if (classification.category === "dizziness") {
    return "Dizziness is not something I’d treat as a movement mechanics issue from here. If it’s new, recurring, or coming with fainting, chest pain, weakness, confusion, or trouble breathing, it’s worth getting checked promptly by someone who can evaluate you directly.\n\nHow long has it been happening, and does it come with fainting, chest pain, weakness, confusion, or trouble breathing?";
  }

  if (classification.category === "medication_effect") {
    return "That sounds more like a possible medication or health-context signal than a movement mechanics issue. I’d bring it up with the clinician or pharmacist connected to that medication, especially if it started after a dose or medication change.\n\nDid this start after a new medication, a changed dose, or stopping something?";
  }

  if (classification.safetyRelevant) {
    return "That does not sound like something I should turn into a movement mechanics investigation. Since it may be medical or systemic rather than mechanical, it’s worth getting it checked by someone who can evaluate you directly, especially if it is new, persistent, or changing.\n\nHow long has this been going on, and has anything else changed with it?";
  }

  if (classification.category === "sleep" || classification.category === "fatigue") {
    return "That sounds more like a general health-context signal than a movement mechanics issue. I’d track when it started and how often it’s happening, and if it keeps showing up or starts affecting your day, it’s worth bringing up with a doctor or clinician.\n\nHow long has this pattern been going on, and is it affecting your normal day?";
  }

  return "That does not sound like a mechanical movement signal, so I would not turn it into a correction or test. I’d track when it shows up and bring it to someone who can evaluate the broader health context if it persists or changes.\n\nHow long has this been happening, and has it changed recently?";
}

function formatNonMechanicalCategoryTitle(
  category: string | null | undefined,
): string {
  const normalized = normalizeCaseKey(category);
  const titles: Record<string, string> = {
    appetite_change: "Appetite Change",
    fatigue: "Fatigue",
    sleep: "Sleep",
    dizziness: "Dizziness",
    illness: "Illness",
    mood: "Mood",
    hydration: "Hydration",
    medication_effect: "Medication Effect",
    taste_change: "Taste Change",
    general_health: "General Health Signal",
  };

  return titles[normalized] ?? "General Health Signal";
}

function isNonMechanicalFollowUpAnswer(userText: string): boolean {
  const t = (userText || "").toLowerCase();

  return /\b(?:\d+\s*(?:day|days|week|weeks|month|months)|one\s+(?:day|week|month)|two\s+(?:days|weeks|months)|three\s+(?:days|weeks|months)|a\s+(?:day|week|month)|since|started|going on|recently|no weight loss|weight loss|dizzy|dizziness|weak|weakness|fever|medication|medicine|meds|changed meds|changed medication|new medication)\b/i.test(
    t,
  );
}

function buildNonMechanicalFollowUpResponse(userText: string): string {
  if (/\b(?:two weeks|2\s*weeks)\b/i.test(userText)) {
    return "Since it’s been going on for about two weeks, it’s worth bringing up with a healthcare professional so they can check for medical, medication, nutrition, dental, or illness-related causes.";
  }

  if (/\b(?:weight loss|dizzy|dizziness|weak|weakness|fever)\b/i.test(userText)) {
    return "That added context is worth keeping with this signal, and it makes this more appropriate for a healthcare professional than a movement mechanics investigation.";
  }

  return "I’ll keep that context with this signal. Since this is medical or health-context information rather than a movement mechanics issue, it’s worth bringing up with a healthcare professional if it persists or keeps changing.";
}

async function getActiveNonMechanicalCaseForUser(
  userId: string,
): Promise<ResolvedCaseRow | null> {
  const [activeCase] = await db
    .select({
      id: cases.id,
      userId: cases.userId,
      conversationId: cases.conversationId,
      movementContext: cases.movementContext,
      activityType: cases.activityType,
      caseType: cases.caseType,
      status: cases.status,
    })
    .from(cases)
    .where(and(eq(cases.userId, userId), eq(cases.caseType, "non_mechanical")))
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(1);

  if (!activeCase || !isOpenCaseStatus(activeCase.status)) {
    return null;
  }

  return activeCase;
}

function normalizeOptionalLabel(value: string | null | undefined): string {
  return normalizeCaseKey(value);
}

function normalizeBodyRegion(input: string | null | undefined): string {
  const value = normalizeCaseKey(input);

  if (!value) return "";
  if (
    /\blower[-\s]?right back\b/.test(value) ||
    /\bright lower back\b/.test(value) ||
    /\blower right side of (?:my |the )?back\b/.test(value) ||
    /\bright side low back\b/.test(value) ||
    /\bright side and back\b/.test(value) ||
    /\blower back right side\b/.test(value) ||
    value.includes("low back") ||
    value.includes("lower back") ||
    value.includes("lumbar")
  ) {
    return "low back";
  }

  return value;
}

function areCompatibleBodyRegions(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftNormalized = normalizeBodyRegion(left);
  const rightNormalized = normalizeBodyRegion(right);
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized) return true;

  const backGroup = new Set([
    "back",
    "low back",
    "lower back",
    "lumbar",
    "right low back",
    "right lower back",
    "right side and back",
  ]);

  return backGroup.has(leftNormalized) && backGroup.has(rightNormalized);
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

function isOpenCaseStatus(status: string | null | undefined): boolean {
  if (status == null) return true;
  return /open|active|current/i.test(String(status));
}

type ResolvedCaseRow = {
  id: number;
  userId: string;
  conversationId: number | null;
  movementContext: string | null;
  activityType: string | null;
  caseType?: string | null;
  status: string | null;
};

async function getConversationOpenCase(
  userId: string,
  conversationId: number,
): Promise<ResolvedCaseRow | null> {
  const [conversationOpenCase] = await db
    .select({
      id: cases.id,
      userId: cases.userId,
      conversationId: cases.conversationId,
      movementContext: cases.movementContext,
      activityType: cases.activityType,
      caseType: cases.caseType,
      status: cases.status,
    })
    .from(cases)
    .where(
      and(
        eq(cases.userId, userId),
        eq(cases.conversationId, conversationId),
        ne(cases.caseType, "non_mechanical"),
      ),
    )
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(1);

  if (!conversationOpenCase || !isOpenCaseStatus(conversationOpenCase.status)) {
    return null;
  }

  return conversationOpenCase;
}

function hasExplicitNewCaseLanguage(text: string): boolean {
  return /\b(?:by the way|btw|another thing|another issue|separately|separate thing|different thing|something else|something different|new issue|new problem|also noticing|also noticed|now i'?m noticing|switching gears)\b/i.test(
    text.trim(),
  );
}

function isReturnToCaseSignal(text: string): boolean {
  return /\b(?:go back to|going back to|back to|returning to|that issue|the walking issue|the shoulder issue|that problem|this issue again)\b/i.test(
    text.trim(),
  );
}

function isMeaningfulCaseBoundaryValue(value: string | null | undefined) {
  const normalized = normalizeOptionalLabel(value);
  return (
    normalized !== "" &&
    normalized !== "general movement" &&
    normalized !== "unspecified"
  );
}

async function resolveReturnToExistingCase({
  userId,
  userText,
}: {
  userId: string;
  userText: string;
}): Promise<ResolvedCaseRow | null> {
  const userCases = await db
    .select({
      id: cases.id,
      userId: cases.userId,
      conversationId: cases.conversationId,
      movementContext: cases.movementContext,
      activityType: cases.activityType,
      caseType: cases.caseType,
      status: cases.status,
    })
    .from(cases)
    .where(eq(cases.userId, userId))
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(6);

  const derived = deriveCaseContext(userText, null);

  for (const userCase of userCases) {
    if (!isOpenCaseStatus(userCase.status)) continue;

    const matchMovement =
      isMeaningfulCaseBoundaryValue(userCase.movementContext) &&
      normalizeCaseKey(userCase.movementContext) ===
        normalizeCaseKey(derived.movementContext);
    const matchActivity =
      isMeaningfulCaseBoundaryValue(userCase.activityType) &&
      normalizeCaseKey(userCase.activityType) ===
        normalizeCaseKey(derived.activityType);

    if (matchMovement || matchActivity) {
      return userCase;
    }
  }

  return null;
}

function extractMechanicalFeatures(
  userText: string,
  activityType?: string | null,
  movementContext?: string | null,
) {
  const t = (userText || "").toLowerCase();
  const a = (activityType || "").toLowerCase();
  const m = (movementContext || "").toLowerCase();

  const isSupine =
    /on (my )?back|lying|supine|reformer/.test(t) ||
    /reformer|lying/.test(m);
  const hasLegLowering =
    /leg(s)? (lower|drop|lowering)|leg circles|legs go lower/.test(t) ||
    /leg circles|lower/.test(m);
  const hasArching = /arch|arching|back lifts|low back lifts/.test(t);
  const isRotational =
    /serve|swing|throw|rotate|rotation/.test(t) || /serve|swing/.test(m);
  const hasExtensionDistribution =
    /swan dive|swan|back extension|prone|lift chest|lifting up|extension|lower back taking over|mostly in my lower back/.test(
      t,
    ) ||
    /swan dive|swan|back extension|prone|lift chest|lifting up|extension/.test(
      m,
    );

  return {
    isSupine,
    hasLegLowering,
    hasArching,
    isRotational,
    hasExtensionDistribution,
  };
}

function classifyMechanicalEnvironment(
  userText: string,
  activityType?: string | null,
  movementContext?: string | null,
): string {
  const f = extractMechanicalFeatures(userText, activityType, movementContext);

  if (f.hasExtensionDistribution) {
    return "extension_distribution";
  }

  if (f.isSupine && f.hasLegLowering && f.hasArching) {
    return "controlled_stability";
  }

  if (f.isRotational) {
    return "rotational_power";
  }

  const t = (userText || "").toLowerCase();
  const m = (movementContext || "").toLowerCase();

  if (/run|walk|stairs/.test(t) || /run|walk/.test(m)) {
    return "locomotion";
  }

  if (/squat|deadlift|press|pull/.test(t) || /squat|deadlift/.test(m)) {
    return "strength_loading";
  }

  return "general";
}

type MechanicalEnvironmentCandidate = {
  environment: string;
  score: number;
  evidence: string[];
};

function resolveMechanicalEnvironment({
  userText,
  activityType,
  movementContext,
  bodyRegion,
}: {
  userText: string;
  activityType?: string | null;
  movementContext?: string | null;
  bodyRegion?: string | null;
}): {
  mechanicalEnvironment: string;
  confidence: number;
  candidates: MechanicalEnvironmentCandidate[];
  selectedByPriorityRule: boolean;
  priorityRule: string;
} {
  const text = (userText || "").toLowerCase();
  const activity = (activityType || "").toLowerCase();
  const movement = (movementContext || "").toLowerCase();
  const region = (bodyRegion || "").toLowerCase();
  const signal = `${text} ${activity} ${movement} ${region}`;
  const candidates: MechanicalEnvironmentCandidate[] = [
    "rotational_power",
    "overhead_loading",
    "controlled_stability",
    "extension_distribution",
    "strength_loading",
    "locomotion",
    "impact_deceleration",
    "reach_or_spacing",
    "compression_or_fold",
    "coordination_timing",
    "positional_load",
    "general",
  ].map((environment) => ({
    environment,
    score: 0,
    evidence: [],
  }));
  const addEvidence = (
    environment: string,
    score: number,
    evidence: string,
  ) => {
    const candidate = candidates.find((item) => item.environment === environment);
    if (!candidate) return;
    candidate.score += score;
    candidate.evidence.push(evidence);
  };
  const matches = (pattern: RegExp) => pattern.test(signal);
  const hasShoulderRegion = /\bshoulder\b|\barm\b/.test(region);
  const hasOverheadSignal =
    matches(/\boverhead\b|\bspike\b|\breach high\b|\breaching high\b|\bhit high\b|\bswing hard\b|\barm overhead\b|\bhigh reach\b/) ||
    (matches(/\bserve\b/) && matches(/\bshoulder\b|\barm\b/));
  const hasCompressionSignals = matches(
    /\bpinch\b|\bpinching\b|\bfront of hip\b|\bhip pinch\b|\bat the bottom\b|\bbottom of squat\b|\bdeep\b|\bgo deep\b|\bdeep squat\b|\bcompressed\b|\bfold\b/,
  );
  const hasDepthFoldSignal = matches(
    /\bdeep\b|\bbottom\b|\bfold\b|\bpinch\b|\bcompressed\b|\bknees to chest\b|\bfront of hip\b/,
  );
  const hasHipKneeRegion = /\bhip\b|\bknee\b/.test(region);
  const hasPositionalStaticSignal = matches(
    /\bsit all day\b|\bsitting\b|\bdesk\b|\bhaven'?t moved\b|\bnot moved\b|\bnot moving\b|\bstanding for a while\b|\bdriving\b|\bafter sitting\b|\bafter being still\b/,
  );

  if (
    matches(
      /\boverhead\b|\bspike\b|\breach high\b|\breaching high\b|\bhit high\b|\bswing hard\b|\bfront of shoulder\b|\bshoulder pinch\b|\bshoulder\b/,
    )
  ) {
    addEvidence("overhead_loading", 3, "overhead or shoulder loading signal");
  }
  if ((hasShoulderRegion || matches(/\bshoulder\b/)) && hasOverheadSignal) {
    addEvidence("overhead_loading", 5, "shoulder region with overhead reach");
  }

  if (
    matches(
      /\brotate\b|\brotation\b|\bturn\b|\bswing\b|\bserve\b|\bdrive serve\b|\bthrow\b|\bhit\b/,
    )
  ) {
    addEvidence("rotational_power", 2, "rotation/swing/serve language");
  }
  if (matches(/\bdrive serve\b/)) {
    addEvidence("rotational_power", 2, "drive serve signal");
  }

  if (
    matches(
      /\bon my back\b|\blying\b|\bsupine\b|\breformer\b|\bleg circles?\b|\blegs? lower\b|\blower my legs\b|\barch\b|\bribs?\b|\bpelvis\b/,
    )
  ) {
    addEvidence("controlled_stability", 3, "supine control signal");
  }

  if (
    matches(
      /\bswan dive\b|\bswan\b|\bback extension\b|\bprone\b|\blift chest\b|\blifting up\b|\bextension\b|\blower back taking over\b|\bmostly in my lower back\b/,
    )
  ) {
    addEvidence("extension_distribution", 3, "extension distribution signal");
  }

  if (
    matches(
      /\bsquat\b|\bdeadlift\b|\bhinge\b|\bpress\b|\bpull\b|\bcarry\b|\bloaded\b|\bweight\b/,
    )
  ) {
    addEvidence("strength_loading", 3, "strength loading signal");
  }

  if (matches(/\brunning\b|\bwalking\b|\bjogging\b|\bstairs\b|\bstride\b/)) {
    addEvidence("locomotion", 3, "locomotion signal");
  }

  if (
    matches(
      /\blanding\b|\bcutting\b|\bstopping\b|\bchange direction\b|\bjump down\b|\bdecelerate\b|\bplant\b/,
    )
  ) {
    addEvidence("impact_deceleration", 3, "impact or deceleration signal");
  }

  if (
    matches(
      /\breaching\b|\breach\b|\btoo far\b|\bjammed\b|\bcrowded\b|\btoo close\b|\btoo far away\b|\bcontact point\b|\bspacing\b/,
    )
  ) {
    addEvidence("reach_or_spacing", 3, "reach or spacing signal");
  }

  if (
    matches(
      /\bdeep squat\b|\bbottom of squat\b|\bpinch\b|\bfold\b|\bcompressed\b|\bknees to chest\b|\bhip pinch\b|\bfront of hip\b|\bat the bottom\b/,
    )
  ) {
    addEvidence("compression_or_fold", 3, "compression or fold signal");
  }
  if (hasCompressionSignals) {
    addEvidence(
      "compression_or_fold",
      6,
      "compression priority: pinch/depth signal",
    );
    addEvidence(
      "strength_loading",
      -2,
      "strength loading penalty: compression signal present",
    );
  }

  if (
    matches(
      /\bout of sync\b|\btiming\b|\bnot smooth\b|\bfeels off\b|\ball at once\b|\bcan'?t coordinate\b|\bcannot coordinate\b|\bsequence\b|\brhythm\b/,
    )
  ) {
    addEvidence("coordination_timing", 3, "coordination or timing signal");
  }

  if (
    matches(
      /\bsitting\b|\bsit all day\b|\bdesk\b|\bdriving\b|\bstanding still\b|\bstanding for a while\b|\blying down\b|\bsleeping\b|\bwake up\b|\bwake up stiff\b|\bafter work\b|\bafter being still\b|\bnot moving\b|\bstiff after sitting\b|\btight after sitting\b|\bafter sitting\b|\bafter standing\b|\bafter sleeping\b|\bnot moved for a while\b/,
    )
  ) {
    addEvidence("positional_load", 4, "static position or sustained posture");
  }

  addEvidence("general", 1, "fallback environment");

  let priorityRule = "score_only";
  if ((hasShoulderRegion || matches(/\bshoulder\b/)) && hasOverheadSignal) {
    addEvidence(
      "overhead_loading",
      10,
      "priority: shoulder overhead beats compression",
    );
    addEvidence(
      "compression_or_fold",
      -8,
      "priority penalty: shoulder overhead signal",
    );
    priorityRule = "shoulder_overhead_beats_compression";
  } else if ((hasHipKneeRegion || matches(/\bfront of hip\b|\bhip\b|\bknee\b/)) && hasDepthFoldSignal) {
    addEvidence(
      "compression_or_fold",
      8,
      "priority: hip/knee depth beats strength",
    );
    addEvidence(
      "strength_loading",
      -4,
      "priority penalty: hip/knee depth signal",
    );
    priorityRule = "hip_knee_depth_beats_strength";
  } else if (hasPositionalStaticSignal) {
    addEvidence(
      "positional_load",
      10,
      "priority: positional static beats inherited movement",
    );
    priorityRule = "positional_static_beats_inherited_movement";
  }

  const dominant = candidates.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best,
  );
  const totalScore = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
  const confidence =
    totalScore > 0 ? Number((dominant.score / totalScore).toFixed(2)) : 0;

  return {
    mechanicalEnvironment: dominant.environment,
    confidence,
    candidates,
    selectedByPriorityRule: priorityRule !== "score_only",
    priorityRule,
  };
}

function classifyMovementFamily(
  userText: string,
  activityType?: string | null,
  movementContext?: string | null,
): string {
  const text = (userText || "").toLowerCase();
  const activity = (activityType || "").toLowerCase();
  const movement = (movementContext || "").toLowerCase();
  const signal = `${text} ${activity} ${movement}`;

  if (
    /\bsit all day\b|\bsitting\b|\bdesk\b|\bhaven'?t moved\b|\bnot moved\b|\bnot moving\b|\bstanding for a while\b|\bdriving\b|\bafter sitting\b|\bafter being still\b/.test(
      text,
    )
  ) {
    return "positional_static";
  }

  if (/\bswan dive\b|\bswan\b/.test(signal)) {
    return "swan_dive";
  }

  if (/\boverhead spike\b|\bspike\b/.test(signal)) {
    return "overhead_spike";
  }

  if (
    /\bleg circles?\b|\blegs? lower\b|\bleg lowering\b|\blower my legs\b|\blegs? drop\b/.test(
      signal,
    )
  ) {
    return "leg_lowering";
  }

  if (
    /\bdrive serve\b/.test(signal) ||
    (/\bdrive\b/.test(signal) && /\bserve\b/.test(signal))
  ) {
    return "drive_serve";
  }

  if (/\bshoulder bridge\b|\bbridge\b/.test(signal)) {
    return "bridge";
  }

  if (/\brun\b|\brunning\b/.test(signal)) {
    return "running";
  }

  if (/\bsquat\b/.test(signal)) {
    return "squat";
  }

  if (/\bdeadlift\b|\bhinge\b/.test(signal)) {
    return "deadlift";
  }

  if (/\bswing\b/.test(signal)) {
    return "swing";
  }

  return "general";
}

function deriveSportDomainForAnalytics(
  userText: string,
  activityType: string | null | undefined,
): string | null {
  const signal = `${userText || ""} ${activityType || ""}`.toLowerCase();

  if (/\bpilates\b|\breformer\b/.test(signal)) return "Pilates";
  if (/\bvolleyball\b|\boverhead spike\b|\bspike\b/.test(signal)) {
    return "volleyball";
  }
  if (/\bbasketball\b|\blayup\b/.test(signal)) return "basketball";
  if (/\bracquetball\b/.test(signal)) return "racquetball";
  if (/\bgolf\b/.test(signal)) return "golf";
  if (/\brunning\b|\brun\b/.test(signal)) return "running";
  if (/\blifting\b|\bstrength\b|\bsquat\b|\bdeadlift\b/.test(signal)) {
    return "lifting";
  }

  return activityType ?? null;
}

function deriveActivityMovementForAnalytics(
  userText: string,
  movementContext: string | null | undefined,
): string | null {
  const signal = `${userText || ""} ${movementContext || ""}`.toLowerCase();

  if (/\bswan dive\b|\bswan\b/.test(signal)) return "Swan Dive";
  if (/\boverhead spike\b|\bspike\b/.test(signal)) return "overhead spike";
  if (/\blayup\b/.test(signal)) return "layup";
  if (/\bleg circles?\b/.test(signal)) return "Leg circles";
  if (/\bshoulder bridge\b/.test(signal)) return "Shoulder bridge";
  if (/\bbridge\b/.test(signal)) return "Bridge";
  if (
    /\bdrive serve\b/.test(signal) ||
    (/\bdrive\b/.test(signal) && /\bserve\b/.test(signal))
  ) {
    return "drive serve";
  }
  if (/\bdeadlift\b|\bhinge\b/.test(signal)) return "deadlift";
  if (/\bsquat\b/.test(signal)) return "squat";
  if (/\brunning\b|\brun\b/.test(signal)) return "running";
  if (/\bswing\b/.test(signal)) return "swing";

  return movementContext ?? null;
}

const FAILURE_MAP: Record<string, readonly string[]> = {
  rotational_power: [
    "weight_stuck_back",
    "early_rotation",
    "late_contact",
    "spacing_error",
    "sequence_breakdown",
    "ribcage_collapse",
  ],

  overhead_loading: [
    "shoulder_pinch_top_range",
    "overhead_range_overreach",
    "scapular_control_loss",
    "arm_path_overload",
    "compensatory_arch",
  ],

  controlled_stability: [
    "ribcage_flare",
    "pelvis_shift",
    "limb_overload",
    "range_exceeds_control",
    "breathing_breakdown",
  ],

  extension_distribution: [
    "low_back_dominance",
    "extension_not_distributed",
    "range_excess",
    "glute_non_participation",
    "neck_overextension",
  ],

  strength_loading: [
    "depth_exceeds_control",
    "joint_load_shift",
    "bracing_failure",
    "weight_distribution_error",
    "range_compensation_pattern",
  ],

  locomotion: [
    "overstriding",
    "push_off_deficit",
    "impact_imbalance",
    "cadence_issue",
    "hip_stability_loss",
  ],

  impact_deceleration: [
    "poor_force_absorption",
    "valgus_collapse",
    "hip_control_loss",
    "stiff_landing",
    "asymmetrical_loading",
  ],

  compression_or_fold: [
    "hip_compression_at_depth",
    "range_too_deep",
    "joint_angle_closure",
    "bottom_position_pinch",
    "structure_loss_in_depth",
  ],

  positional_load: [
    "sustained_position_load",
    "movement_variability_absent",
    "posture_duration_sensitivity",
    "stiffness_accumulation",
  ],
};

function resolveDominantFailurePattern({
  userText,
  activityType,
  movementContext,
  bodyRegion,
  mechanicalEnvironment,
}: {
  userText: string;
  activityType?: string | null;
  movementContext?: string | null;
  bodyRegion?: string | null;
  mechanicalEnvironment: string;
}): {
  dominantFailure: string;
  confidence: number;
  candidates: FailurePatternCandidate[];
} {
  const text = (userText || "").toLowerCase();
  const movement = (movementContext || "").toLowerCase();
  const region = (bodyRegion || "").toLowerCase();
  const activity = (activityType || "").toLowerCase();
  const signal = `${text} ${activity} ${movement} ${region}`;
  const failureSet = FAILURE_MAP[mechanicalEnvironment] ?? [
    "general_load_shift",
  ];
  console.log("FAILURE_MAP_SELECTED", {
    mechanicalEnvironment,
    candidateFailures: failureSet,
  });
  const candidates = failureSet.map((failure) => ({
    failure,
    score: 0,
    evidence: [] as string[],
  }));
  const addEvidence = (failure: string, score: number, evidence: string) => {
    const candidate = candidates.find((item) => item.failure === failure);
    if (!candidate) return;
    candidate.score += score;
    candidate.evidence.push(evidence);
  };
  const matches = (pattern: RegExp) => pattern.test(signal);

  if (mechanicalEnvironment === "controlled_stability") {
    if (matches(/\blower\b|\bgo lower\b|\btoo low\b|\bdrop\b/)) {
      addEvidence("range_exceeds_control", 2, "lowering/range depth language");
    }
    if (matches(/\barch\b|\barching\b|\bback lifts\b|\blow back lifts\b/)) {
      addEvidence("range_exceeds_control", 3, "arching or low-back lift");
    }
    if (matches(/\bribs?\b/)) {
      addEvidence("ribcage_flare", 2, "rib flare language");
    }
    if (matches(/\bpelvis\b|\bshift\b/)) {
      addEvidence("pelvis_shift", 2, "pelvis shift language");
    }
    if (matches(/\bleg\b|\blegs\b|\blimb\b/)) {
      addEvidence("limb_overload", 2, "limb loading language");
    }
    if (matches(/\bbreath\b|\bbreathing\b/)) {
      addEvidence("breathing_breakdown", 2, "breathing language");
    }
  } else if (mechanicalEnvironment === "extension_distribution") {
    if (
      matches(
        /\bmostly in my lower back\b|\blower back taking over\b|\bback tight\b|\btight in my lower back\b/,
      )
    ) {
      addEvidence("low_back_dominance", 3, "low-back dominance language");
    }
    if (matches(/\blower back\b/) && matches(/\btight\b|\btighten\b|\btightness\b/)) {
      addEvidence("low_back_dominance", 2, "low-back tightness");
    }
    if (matches(/\blift higher\b|\btoo high\b|\btry to lift up\b|\blifting up\b/)) {
      addEvidence("range_excess", 2, "lifting range language");
    }
    if (matches(/\bneck\b|\bshoulder\b/)) {
      addEvidence("neck_overextension", 2, "neck or shoulder takeover");
    }
    if (matches(/\bnot smooth\b|\bdoesn'?t feel smooth\b|\bload\b/)) {
      addEvidence(
        "extension_not_distributed",
        2,
        "distribution or smoothness language",
      );
    }
    if (matches(/\bglute\b|\bglutes\b/)) {
      addEvidence("glute_non_participation", 2, "glute participation language");
    }
  } else if (mechanicalEnvironment === "rotational_power") {
    if (matches(/\bopen early\b|\bturn early\b/)) {
      addEvidence("early_rotation", 2, "early turn/opening language");
    }
    if (matches(/\bstuck back\b|\bweight back\b|\bback foot\b|\bnot transferring\b/)) {
      addEvidence("weight_stuck_back", 2, "weight stuck back language");
    }
    if (matches(/\bjammed\b|\blate\b/)) {
      addEvidence("late_contact", 2, "late/jammed contact language");
    }
    if (matches(/\breach\b|\breaching\b|\bspacing\b|\btoo far\b|\btoo close\b/)) {
      addEvidence("spacing_error", 2, "spacing/reaching language");
    }
    if (matches(/\bhips?\b|\btrunk\b|\btiming\b/)) {
      addEvidence("sequence_breakdown", 2, "hip/trunk/timing language");
    }
    if (matches(/\bserve\b/) && matches(/\bback\b/)) {
      addEvidence("sequence_breakdown", 1, "serve with back signal");
    }
    if (matches(/\brib\b|\bribcage\b|\bcollapse\b/)) {
      addEvidence("ribcage_collapse", 2, "ribcage collapse language");
    }
  } else if (mechanicalEnvironment === "strength_loading") {
    if (matches(/\bbrace\b|\bbracing\b|\bloose\b/)) {
      addEvidence("bracing_failure", 2, "bracing language");
    }
    if (matches(/\btoo low\b|\btoo deep\b|\brange\b|\bdepth\b/)) {
      addEvidence("depth_exceeds_control", 2, "depth/range language");
    }
    if (matches(/\bjoint\b|\bknee\b|\bhip\b|\bback\b/) && matches(/\bshift\b|\bload\b/)) {
      addEvidence("joint_load_shift", 2, "joint load shift language");
    }
    if (matches(/\bweight\b|\bpressure\b|\buneven\b|\bone side\b/)) {
      addEvidence("weight_distribution_error", 2, "weight distribution language");
    }
    if (matches(/\bcompensat\b|\bround\b|\bhinge\b/)) {
      addEvidence("range_compensation_pattern", 2, "compensation pattern language");
    }
  } else if (mechanicalEnvironment === "locomotion") {
    if (matches(/\bimpact\b|\bpounding\b|\bjarring\b/)) {
      addEvidence("impact_imbalance", 2, "impact language");
    }
    if (matches(/\boverstride\b|\breach\b|\bstride\b/)) {
      addEvidence("overstriding", 2, "stride overreach language");
    }
    if (matches(/\bpush off\b|\btoe off\b|\bone side\b/)) {
      addEvidence("push_off_deficit", 2, "push-off asymmetry language");
    }
    if (matches(/\bcadence\b|\brhythm\b|\btempo\b/)) {
      addEvidence("cadence_issue", 2, "cadence language");
    }
    if (matches(/\bhip\b|\bstable\b|\bstability\b/)) {
      addEvidence("hip_stability_loss", 2, "hip stability language");
    }
  } else if (mechanicalEnvironment === "impact_deceleration") {
    if (matches(/\blanding\b|\bjump down\b|\babsorb\b|\babsorption\b/)) {
      addEvidence("poor_force_absorption", 2, "landing/absorption language");
    }
    if (matches(/\bvalgus\b|\bcollapse\b|\bknee cave\b/)) {
      addEvidence("valgus_collapse", 2, "valgus/collapse language");
    }
    if (matches(/\bhip\b|\bcutting\b|\bchange direction\b/)) {
      addEvidence("hip_control_loss", 2, "hip/cutting control language");
    }
    if (matches(/\bstiff\b|\brigid\b/)) {
      addEvidence("stiff_landing", 2, "stiff landing language");
    }
    if (matches(/\basymmetrical\b|\basymmetric\b|\bone side\b|\buneven\b/)) {
      addEvidence("asymmetrical_loading", 2, "asymmetrical loading language");
    }
  } else if (mechanicalEnvironment === "reach_or_spacing") {
    if (matches(/\breaching\b|\breach\b|\btoo far\b|\btoo far away\b/)) {
      addEvidence("overreach", 2, "overreach language");
    }
    if (matches(/\bjammed\b|\bcrowded\b|\btoo close\b/)) {
      addEvidence("crowded_contact", 2, "crowded contact language");
    }
    if (matches(/\bspacing\b/)) {
      addEvidence("spacing_mismatch", 2, "spacing language");
    }
    if (matches(/\bcontact point\b/)) {
      addEvidence("contact_point_drift", 2, "contact point language");
    }
  } else if (mechanicalEnvironment === "compression_or_fold") {
    if (matches(/\bpinch\b|\bpinching\b|\bhip pinch\b|\bfront of hip\b/)) {
      addEvidence("hip_compression_at_depth", 4, "hip pinch/compression language");
    }
    if (matches(/\bdeep\b|\bgo deep\b|\bbottom\b|\bbottom of squat\b|\bat the bottom\b/)) {
      addEvidence("range_too_deep", 3, "deep/bottom range language");
    }
    if (matches(/\bcompressed\b|\bclosing\b|\bfold\b|\bknees to chest\b/)) {
      addEvidence("joint_angle_closure", 3, "joint angle closure language");
    }
    if (matches(/\bat the bottom\b|\bbottom of squat\b|\bpinch\b/)) {
      addEvidence("bottom_position_pinch", 2, "bottom position pinch");
    }
  } else if (mechanicalEnvironment === "coordination_timing") {
    if (matches(/\bsequence\b|\bout of sync\b/)) {
      addEvidence("sequence_breakdown", 2, "sequence language");
    }
    if (matches(/\btiming\b/)) {
      addEvidence("timing_mismatch", 2, "timing language");
    }
    if (matches(/\brhythm\b|\bnot smooth\b|\bfeels off\b/)) {
      addEvidence("rhythm_loss", 2, "rhythm or smoothness language");
    }
    if (matches(/\ball at once\b|\bcan'?t coordinate\b|\bcannot coordinate\b/)) {
      addEvidence("all_at_once_strategy", 2, "coordination collapse language");
    }
  } else if (mechanicalEnvironment === "positional_load") {
    if (matches(/\bsitting\b|\bsit all day\b|\bdesk\b|\bdriving\b|\bstanding still\b|\bstanding for a while\b|\blying down\b|\bsleeping\b/)) {
      addEvidence("sustained_position_load", 2, "sustained position language");
    }
    if (matches(/\bnot moving\b|\bnot moved for a while\b|\bafter being still\b/)) {
      addEvidence("movement_variability_absent", 2, "lack of variation language");
    }
    if (matches(/\bafter sitting\b|\bafter standing\b|\bafter work\b|\bafter sleeping\b/)) {
      addEvidence("posture_duration_sensitivity", 2, "duration sensitivity language");
    }
    if (matches(/\bstiff after sitting\b|\btight after sitting\b|\bwake up stiff\b/)) {
      addEvidence("stiffness_accumulation", 2, "stillness stiffness language");
    }
  } else if (mechanicalEnvironment === "overhead_loading") {
    if (matches(/\bfront of (?:my )?shoulder\b|\bshoulder pinch\b|\bpinch\b/)) {
      addEvidence("shoulder_pinch_top_range", 3, "shoulder pinch language");
    }
    if (matches(/\boverhead\b|\breach high\b|\breaching high\b|\bhit high\b|\bspike\b/)) {
      addEvidence("overhead_range_overreach", 2, "overhead reach language");
    }
    if (matches(/\bshoulder blade\b|\bscapula\b|\bscapular\b/)) {
      addEvidence("scapular_control_loss", 2, "shoulder blade control language");
    }
    if (matches(/\bswing hard\b|\barm path\b|\bhit\b/)) {
      addEvidence("arm_path_overload", 2, "arm path or swing force language");
    }
    if (matches(/\barch\b|\barching\b|\blow back\b|\bribs?\b/)) {
      addEvidence("compensatory_arch", 2, "compensatory arch language");
    }
  } else {
    addEvidence("general_load_shift", 1, "fallback mechanical signal");
  }

  const dominant = candidates.reduce((best, candidate) =>
    candidate.score > best.score ? candidate : best,
  );
  const totalScore = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
  const confidence =
    totalScore > 0 ? Number((dominant.score / totalScore).toFixed(2)) : 0;
  const dominantFailure = dominant.score > 0 ? dominant.failure : "general_load_shift";

  return {
    dominantFailure,
    confidence,
    candidates,
  };
}

async function shouldStartNewCaseForSignal({
  userText,
  currentCase,
  derivedMovementContext,
  derivedActivityType,
  derivedBodyRegion,
  derivedSignalType,
}: {
  userText: string;
  currentCase: ResolvedCaseRow;
  derivedMovementContext: string;
  derivedActivityType: string;
  derivedBodyRegion: string | null;
  derivedSignalType: string | null;
}): Promise<{
  shouldStartNewCase: boolean;
  reason: string | null;
  bodyRegion?: string | null;
  signalType?: string | null;
  movementContext?: string | null;
  activityType?: string | null;
  previousBodyRegion?: string | null;
  previousSignalType?: string | null;
  previousMovementContext?: string | null;
  previousActivityType?: string | null;
  derivedMovementFamily?: string | null;
  previousMovementFamily?: string | null;
}> {
  const derived = {
    bodyRegion: derivedBodyRegion,
    signalType: derivedSignalType,
    movementContext: derivedMovementContext,
    activityType: derivedActivityType,
  };

  if (hasExplicitNewCaseLanguage(userText)) {
    return {
      shouldStartNewCase: true,
      reason: "explicit_new_case_language",
      ...derived,
    };
  }

  const [latestSignal] = await db
    .select({
      bodyRegion: caseSignals.bodyRegion,
      signalType: caseSignals.signalType,
      movementContext: caseSignals.movementContext,
      activityType: caseSignals.activityType,
      description: caseSignals.description,
    })
    .from(caseSignals)
    .where(eq(caseSignals.caseId, currentCase.id))
    .orderBy(desc(caseSignals.id))
    .limit(1);

  if (!latestSignal) {
    return { shouldStartNewCase: false, reason: null, ...derived };
  }

  const previousBodyRegion =
    latestSignal.bodyRegion ?? deriveBodyRegion(latestSignal.description ?? "");
  const previousSignalType =
    latestSignal.signalType ?? deriveSignalType(latestSignal.description ?? "");
  const previousMovementContext =
    latestSignal.movementContext ?? currentCase.movementContext;
  const previousActivityType =
    latestSignal.activityType ?? currentCase.activityType;
  const previous = {
    previousBodyRegion,
    previousSignalType,
    previousMovementContext,
    previousActivityType,
  };
  const normalizedDerivedBodyRegion = normalizeBodyRegion(derivedBodyRegion);
  const normalizedPreviousBodyRegion = normalizeBodyRegion(previousBodyRegion);
  const derivedEnvironment = classifyMechanicalEnvironment(
    userText,
    derivedActivityType,
    derivedMovementContext,
  );
  const previousEnvironment = classifyMechanicalEnvironment(
    latestSignal.description ?? "",
    previousActivityType,
    previousMovementContext,
  );
  const derivedMovementFamily = classifyMovementFamily(
    userText,
    derivedActivityType,
    derivedMovementContext,
  );
  const previousMovementFamily = classifyMovementFamily(
    latestSignal.description ?? "",
    previousActivityType,
    previousMovementContext,
  );
  const movementFamilyBoundary = {
    derivedMovementFamily,
    previousMovementFamily,
  };

  console.log("CASE_BOUNDARY_COMPARISON", {
    derived: derivedBodyRegion,
    previous: previousBodyRegion,
    normalizedDerived: normalizedDerivedBodyRegion,
    normalizedPrevious: normalizedPreviousBodyRegion,
  });
  console.log("CASE_MOVEMENT_FAMILY_CHECK", {
    derivedMovementFamily,
    previousMovementFamily,
    derivedMovementContext,
    previousMovementContext,
    derivedActivityType,
    previousActivityType,
  });

  if (
    isMeaningfulCaseBoundaryValue(previousBodyRegion) &&
    isMeaningfulCaseBoundaryValue(derivedBodyRegion) &&
    areCompatibleBodyRegions(previousBodyRegion, derivedBodyRegion)
  ) {
    if (derivedEnvironment !== previousEnvironment) {
      return {
        shouldStartNewCase: true,
        reason: `environment_shift:${previousEnvironment}->${derivedEnvironment}`,
        ...movementFamilyBoundary,
        ...derived,
        ...previous,
      };
    }

    if (
      previousMovementFamily !== "general" &&
      derivedMovementFamily !== "general" &&
      previousMovementFamily !== derivedMovementFamily
    ) {
      return {
        shouldStartNewCase: true,
        reason: `movement_family_shift:${previousMovementFamily}->${derivedMovementFamily}`,
        ...movementFamilyBoundary,
        ...derived,
        ...previous,
      };
    }

    if (
      isMeaningfulCaseBoundaryValue(previousActivityType) &&
      isMeaningfulCaseBoundaryValue(derivedActivityType) &&
      normalizeOptionalLabel(previousActivityType) !==
        normalizeOptionalLabel(derivedActivityType)
    ) {
      return {
        shouldStartNewCase: true,
        reason: `activity_shift:${previousActivityType}->${derivedActivityType}`,
        ...movementFamilyBoundary,
        ...derived,
        ...previous,
      };
    }

    return {
      shouldStartNewCase: false,
      reason: "same_case_fit_body_region_compatible",
      ...movementFamilyBoundary,
      ...derived,
      ...previous,
    };
  }

  if (
    isMeaningfulCaseBoundaryValue(previousBodyRegion) &&
    isMeaningfulCaseBoundaryValue(derivedBodyRegion) &&
    normalizedPreviousBodyRegion !== normalizedDerivedBodyRegion
  ) {
    return {
      shouldStartNewCase: true,
      reason: `body_region_shift:${previousBodyRegion}->${derivedBodyRegion}`,
      ...movementFamilyBoundary,
      ...derived,
      ...previous,
    };
  }

  if (
    isMeaningfulCaseBoundaryValue(previousSignalType) &&
    isMeaningfulCaseBoundaryValue(derivedSignalType) &&
    normalizeOptionalLabel(previousSignalType) !==
      normalizeOptionalLabel(derivedSignalType)
  ) {
    return {
      shouldStartNewCase: false,
      reason: `same_case_fit_context_drift:signal_type:${previousSignalType}->${derivedSignalType}`,
      ...movementFamilyBoundary,
      ...derived,
      ...previous,
    };
  }

  if (
    isMeaningfulCaseBoundaryValue(previousMovementContext) &&
    isMeaningfulCaseBoundaryValue(derivedMovementContext) &&
    normalizeOptionalLabel(previousMovementContext) !==
      normalizeOptionalLabel(derivedMovementContext)
  ) {
    return {
      shouldStartNewCase: false,
      reason: `same_case_fit_context_drift:movement_context:${previousMovementContext}->${derivedMovementContext}`,
      ...movementFamilyBoundary,
      ...derived,
      ...previous,
    };
  }

  if (
    isMeaningfulCaseBoundaryValue(previousActivityType) &&
    isMeaningfulCaseBoundaryValue(derivedActivityType) &&
    normalizeOptionalLabel(previousActivityType) !==
      normalizeOptionalLabel(derivedActivityType)
  ) {
    return {
      shouldStartNewCase: true,
      reason: `activity_shift:${previousActivityType}->${derivedActivityType}`,
      ...movementFamilyBoundary,
      ...derived,
      ...previous,
    };
  }

  return {
    shouldStartNewCase: false,
    reason: "same_case_fit",
    ...movementFamilyBoundary,
    ...derived,
    ...previous,
  };
}

async function writeCaseSignalIfNew({
  userId,
  caseId,
  description,
  activityType,
  movementContext,
  bodyRegion,
  signalType,
}: {
  userId: string;
  caseId: number;
  description: string;
  activityType: string;
  movementContext: string;
  bodyRegion: string | null;
  signalType: string | null;
}): Promise<boolean> {
  const normalizedDescription = clampText(description, 800);
  const [lastSignal] = await db
    .select({
      description: caseSignals.description,
    })
    .from(caseSignals)
    .where(eq(caseSignals.caseId, caseId))
    .orderBy(desc(caseSignals.id))
    .limit(1);

  if (
    areEquivalentDashboardCandidates(
      normalizedDescription,
      lastSignal?.description,
    )
  ) {
    console.log("CASE_SIGNAL_DUPLICATE_SKIPPED", {
      caseId,
      signalPreview: clampText(normalizedDescription, 120),
    });

    return false;
  }

  await db.insert(caseSignals).values({
    userId,
    caseId,
    description: normalizedDescription,
    activityType,
    movementContext,
    bodyRegion,
    signalType,
  });

  return true;
}

async function getLatestCaseSignalSnapshot(
  caseId: number,
  currentCase?: ResolvedCaseRow | null,
): Promise<{
  bodyRegion: string | null;
  signalType: string | null;
  movementContext: string | null;
  activityType: string | null;
}> {
  const [latestSignal] = await db
    .select({
      bodyRegion: caseSignals.bodyRegion,
      signalType: caseSignals.signalType,
      movementContext: caseSignals.movementContext,
      activityType: caseSignals.activityType,
      description: caseSignals.description,
    })
    .from(caseSignals)
    .where(eq(caseSignals.caseId, caseId))
    .orderBy(desc(caseSignals.id))
    .limit(1);

  return {
    bodyRegion:
      latestSignal?.bodyRegion ??
      deriveBodyRegion(latestSignal?.description ?? ""),
    signalType:
      latestSignal?.signalType ??
      deriveSignalType(latestSignal?.description ?? ""),
    movementContext:
      latestSignal?.movementContext ?? currentCase?.movementContext ?? null,
    activityType: latestSignal?.activityType ?? currentCase?.activityType ?? null,
  };
}

async function resolveCaseReviewTargetCase({
  userId,
  conversationId,
  currentCase,
}: {
  userId: string;
  conversationId: number;
  currentCase: ResolvedCaseRow | null;
}): Promise<ResolvedCaseRow | null> {
  if (currentCase) return currentCase;

  const conversationCase = await getConversationOpenCase(
    userId,
    conversationId,
  );
  if (conversationCase) return conversationCase;

  const [latestOpenUserCase] = await db
    .select({
      id: cases.id,
      userId: cases.userId,
      conversationId: cases.conversationId,
      movementContext: cases.movementContext,
      activityType: cases.activityType,
      caseType: cases.caseType,
      status: cases.status,
    })
    .from(cases)
    .where(eq(cases.userId, userId))
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(8);

  if (latestOpenUserCase && isOpenCaseStatus(latestOpenUserCase.status)) {
    return latestOpenUserCase;
  }

  const [latestUserCase] = await db
    .select({
      id: cases.id,
      userId: cases.userId,
      conversationId: cases.conversationId,
      movementContext: cases.movementContext,
      activityType: cases.activityType,
      caseType: cases.caseType,
      status: cases.status,
    })
    .from(cases)
    .where(eq(cases.userId, userId))
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(1);

  return latestUserCase ?? null;
}

function extractFirstMatchingSentence(
  text: string,
  patterns: RegExp[],
  options?: { rejectMechanismSentences?: boolean },
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
      if (
        options?.rejectMechanismSentences &&
        /^(?:the issue is|the problem is|what'?s happening is|this is happening because|this is driven by|this comes from|your .* is compensating|your .* is taking over)\b/i.test(
          normalized,
        )
      ) {
        return null;
      }
      if (patternMatches === 0) return null;

      let score = patternMatches * 5;
      if (isStrongHypothesisCandidate(normalized)) score += 12;
      if (isStrongAdjustmentCandidate(normalized)) score += 12;
      if (isMechanismLikeText(normalized)) score += 5;
      if (isTestLikeText(normalized)) score += 5;
      if (
        /\b(?:because|due to|driven by|caused by|suggests|indicates|means|points to)\b/i.test(
          normalized,
        )
      ) {
        score += 4;
      }
      if (
        /^(?:try|make sure|let|allow|shift|load|relax|drive|rotate|brace|stack|press|pull|push|hinge|hold|stay)\b/i.test(
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

function isGenericAdjustmentFillerText(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return true;

  const normalized = normalizeDashboardCandidate(text);

  const genericExactValues = new Set([
    "try this adjustment",
    "try this adjustment and",
    "keep observing",
    "continue observing",
    "continue doing this",
    "keep doing this",
    "focus on this",
    "work on this",
    "stay aware of this",
    "be aware of this",
  ]);

  if (genericExactValues.has(normalized)) return true;

  return (
    /\btry this adjustment\b/i.test(text) ||
    /\bkeep observing\b/i.test(text) ||
    /\bcontinue observing\b/i.test(text) ||
    /\bcontinue doing\b/i.test(text) ||
    /\bkeep doing\b/i.test(text) ||
    /\bstay aware of\b/i.test(text) ||
    /\bbe aware of\b/i.test(text) ||
    /^\s*focus on(?:\s+this|\s+that|\s+it)?\s*[.!?]?$/i.test(text) ||
    /^\s*try(?:\s+this|\s+that|\s+it)?\s*[.!?]?$/i.test(text) ||
    /^\s*make sure(?:\s+this|\s+that|\s+it)?\s*[.!?]?$/i.test(text) ||
    /^\s*keep(?:\s+this|\s+that|\s+it)?\s*[.!?]?$/i.test(text) ||
    /^\s*let(?:\s+this|\s+that|\s+it)?\s*[.!?]?$/i.test(text) ||
    /^\s*allow(?:\s+this|\s+that|\s+it)?\s*[.!?]?$/i.test(text) ||
    /^\s*think about(?:\s+this|\s+that|\s+it)?\s*[.!?]?$/i.test(text)
  );
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
    /\bsuggests\b/i,
    /\bindicates\b/i,
    /\bmeans\b/i,
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

  const explanatoryMechanismPatterns = [
    /\bleading to\b/i,
    /\bresulting in\b/i,
    /\bcontributing to\b/i,
    /\bwhich was affecting\b/i,
    /\bat rest leading\b/i,
    /\breduced circulation\b/i,
    /\breduced mobility\b/i,
    /\blimiting\b/i,
    /\bpreventing\b/i,
    /\binhibiting\b/i,
    /\brestricting\b/i,
  ];

  return (
    explicitMechanismPatterns.some((pattern) => pattern.test(text)) ||
    declarativeMechanismPatterns.some((pattern) => pattern.test(text)) ||
    explanatoryMechanismPatterns.some((pattern) => pattern.test(text)) ||
    /\breduced\b[^.!?]{1,80}\bduring\b/i.test(text) ||
    /\bloss of\b[^.!?]{1,80}\bduring\b/i.test(text)
  );
}

function hasRealMechanicalLever(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;
  if (text.length < 35) return false;
  if (isGenericAdjustmentFillerText(text)) return false;
  if (isGenericCoachingFillerText(text)) return false;
  if (isLowSignalShiftText(text)) return false;

  const actionPattern =
    /^\s*(?:try|test|use|take|do|walk|focus on|keep|make sure|let|allow|shift|load|relax|drive|rotate|control|stack|move|press|pull|push|hinge|brace|stabilize|stabilise|hold|clear|stay|reduce|increase|shorten|lengthen|soften|slow)\b/i;

  const mechanicalObjectPattern =
    /\b(?:hip|hips|side|rib|ribs|pelvis|trunk|shoulder|shoulders|back|spine|brace|load|stack|rotate|rotation|hinge|foot|feet|ankle|knee|knees|glute|glutes|serve|swing|contact|backswing|pressure|weight|chest|torso|lat|lats|core|elbow|wrist|stride|step|steps|gait|walk|walking|tension|range|position|speed|tempo)\b/i;

  const changePattern =
    /\b(?:instead of|rather than|before|after|through|under|until|as you|while you|during|into|out of|against|toward|away|forward|back|down|up|open|closed|hold|release|load|shift|drive|rotate|brace|stack|hinge|press|pull|push|clear|with|without|for|across|between|from|reduced|increased|shorter|longer|slow|slower|observe|notice|feel)\b/i;

  return (
    actionPattern.test(text) &&
    mechanicalObjectPattern.test(text) &&
    changePattern.test(text)
  );
}

function isTestLikeText(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;
  if (isGenericAdjustmentFillerText(text)) return false;
  if (isWeakTestInstructionText(text)) return false;

  const concreteActionStartPatterns = [
    /^\s*try\b/i,
    /^\s*test\b/i,
    /^\s*use\b/i,
    /^\s*take\b/i,
    /^\s*do\b/i,
    /^\s*walk\b/i,
    /^\s*focus on\b/i,
    /^\s*keep\b/i,
    /^\s*make sure\b/i,
    /^\s*let\b/i,
    /^\s*allow\b/i,
    /^\s*shift\b/i,
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
    /^\s*reduce\b/i,
    /^\s*increase\b/i,
    /^\s*shorten\b/i,
    /^\s*lengthen\b/i,
    /^\s*soften\b/i,
    /^\s*slow\b/i,
  ];

  const diagnosisPatterns = [
    /\bbecause\b/i,
    /\bdue to\b/i,
    /\bdriven by\b/i,
    /\bcaused by\b/i,
    /\bcoming from\b/i,
    /\bhappening because\b/i,
    /\bsuggests\b/i,
    /\bindicates\b/i,
    /\bmeans\b/i,
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

  return hasRealMechanicalLever(text);
}

function isWeakTestInstructionText(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return true;

  const hasConcreteDose =
    /\b(?:1|one|2|two|3|three)\s+(?:rep|reps|step|steps|serve|serves|reach|reaches|swing|swings|motion|motions|load|loads)\b/i.test(
      text,
    ) ||
    /\b(?:take|do|try|test)\s+(?:1|one|2|two|3|three)\b/i.test(text) ||
    /\b(?:once|one[-\s]?time)\b/i.test(text) ||
    /\bfor\s+(?:10|ten|20|twenty|30|thirty)\s+seconds\b/i.test(text) ||
    /\b(?:take|do)\s+3\b/i.test(text) ||
    /\bdo\s+one\b/i.test(text);

  const hasRepOrShortSequence =
    hasConcreteDose ||
    /\b(?:take|do|try|test)\s+(?:one|1|two|2|three|3|a few)\b/i.test(text) ||
    /\b(?:one|1|two|2|three|3)\s+(?:rep|reps|step|steps|serve|serves|reach|reaches|swing|swings)\b/i.test(
      text,
    ) ||
    /\b(?:for|through)\s+(?:the first|one|1|two|2|three|3)\b/i.test(text);

  const hasObservation =
    /\b(?:tell me|notice|observe|feel if|check whether|see if|whether|when it|where it|if the)\b/i.test(
      text,
    );

  const hasVagueCue = [
    /^\s*focus on\b/i,
    /\btry to\b/i,
    /\bbe mindful of\b/i,
    /\bengage your core\b/i,
    /\bactivate your core\b/i,
    /\bcore engagement\b/i,
    /\bmaintain core\b/i,
    /\bproper form\b/i,
    /\bgood posture\b/i,
    /\bimprove stability\b/i,
    /\brotational stability\b/i,
    /\bdistribute the load\b/i,
    /\bcontrolled rotation\b/i,
    /\bstrengthen\b/i,
    /\bexercises?\b/i,
    /\broutine\b/i,
    /\bdrill\b/i,
  ].some((pattern) => pattern.test(text));

  if (hasVagueCue && !(hasConcreteDose && hasObservation)) {
    return true;
  }

  return !(hasRepOrShortSequence && hasObservation);
}

function getConcreteTestInvalidReason(value: string | null | undefined): string | null {
  const text = normalizePreviewValue(value);
  if (!text) return "empty";
  if (text.length < 35) return "too_short";

  const vaguePatterns = [
    /^\s*focus on\b/i,
    /\bfocusing on\b/i,
    /\bengage\b/i,
    /\bengage your core\b/i,
    /\bimprove\b/i,
    /\bwork on\b/i,
    /\btry to\b/i,
    /\btry and\b/i,
    /\bmaintain\b/i,
    /\bnotice if\b/i,
    /\bconsciously\b/i,
    /\bpay attention\b/i,
    /\bbe mindful\b/i,
    /\bstrengthen\b/i,
    /\bstabilize\b/i,
    /\bstabilizing\b/i,
    /\bstability\b/i,
    /\buse better\b/i,
    /\bdistribute the load\b/i,
    /\bcontrolled rotation\b/i,
    /\bimprove hip rotation\b/i,
    /\btrunk engagement\b/i,
    /\bconsciously engaging\b/i,
    /\bengage the hips\b/i,
    /\bengage the trunk\b/i,
    /\binadequate hip rotation\b/i,
    /\binadequate trunk engagement\b/i,
    /\bincreased right low back strain\b/i,
    /\bnote any change\b/i,
    /\bperform a drive serve\b/i,
    /\bcore engagement\b/i,
  ];

  if (vaguePatterns.some((pattern) => pattern.test(text))) {
    return "vague_coaching_language";
  }

  const hasFiniteDose =
    /\b(?:1|one|2|two|3|three|5|five)\s+(?:rep|reps|motion|motions|serve|serves|step|steps|time|times|trial|trials|load|loads|reach|reaches|swing|swings)\b/i.test(
      text,
    ) ||
    /\b(?:do|take|try|test)\s+(?:1|one|2|two|3|three|5|five)\b/i.test(text) ||
    /\b(?:once|one[-\s]?time)\b/i.test(text) ||
    /\bfor\s+(?:10|ten|20|twenty|30|thirty)\s+seconds\b/i.test(text);

  if (!hasFiniteDose) return "missing_finite_dose";

  const hasObservableReturn =
    /\b(?:tell me|notice whether|report|see if|where|when|during|after|before|whether|if the)\b/i.test(
      text,
    );

  if (!hasObservableReturn) return "missing_observable_return";

  return null;
}

function isValidConcreteTest(value: string | null | undefined): boolean {
  return getConcreteTestInvalidReason(value) === null;
}

function hasExplicitDriveServeContext(
  ...values: Array<string | null | undefined>
): boolean {
  return /\bdrive[-\s]?serves?\b/i.test(
    values
      .map((value) => normalizePreviewValue(value))
      .filter(Boolean)
      .join(" "),
  );
}

function getAdjustmentContextRejectionReason({
  candidate,
  userText,
  movementContext,
  bodyRegion,
  activityType,
}: {
  candidate: string | null | undefined;
  userText?: string | null;
  movementContext?: string | null;
  bodyRegion?: string | null;
  activityType?: string | null;
}): string | null {
  const candidateText = normalizePreviewValue(candidate);
  if (!candidateText) return null;

  if (
    /\bdrive[-\s]?serve\b/i.test(candidateText) &&
    !hasExplicitDriveServeContext(userText, movementContext, bodyRegion, activityType)
  ) {
    return "drive_serve_candidate_without_explicit_drive_serve_context";
  }

  return null;
}

function buildFallbackConcreteTest({
  userText,
  hypothesis,
  movementContext,
  bodyRegion,
  activityType,
}: {
  userText: string;
  hypothesis?: string | null;
  movementContext?: string | null;
  bodyRegion?: string | null;
  activityType?: string | null;
}): string {
  const source = `${userText} ${hypothesis ?? ""} ${movementContext ?? ""} ${
    activityType ?? ""
  }`;
  const region = bodyRegion || deriveBodyRegion(userText) || "symptom";
  const regionPhrase =
    /\blow back|lower back|right low|right lower|lumbar/i.test(source)
      ? "right low-back tightness"
      : region === "low back"
        ? "low-back tightness"
        : `${region} symptom`;

  if (hasExplicitDriveServeContext(source) && /\bracquetball\b/i.test(source)) {
    const direction = /\bleft\b/i.test(source) ? " to the left" : "";
    return `Do 3 slow drive-serve motions${direction} without a ball. Start the turn from your hips before your trunk moves. Let me know if the stiffness and tightness change.`;
  }

  const movement = normalizePreviewValue(movementContext);
  if (movement && !isFallbackMovementContext(movement)) {
    return `Do 3 slow ${movement} motions and change one thing: start the motion from the hips before the trunk moves. Tell me if the ${regionPhrase} appears before that hip turn or after it.`;
  }

  return `Do 3 slow reps of the movement that triggered it and change one thing: start from the hips before the trunk moves. Tell me if the ${regionPhrase} appears before that transfer or after it.`;
}

function enforceConcreteTestCandidate({
  caseId,
  candidate,
  userText,
  hypothesis,
  movementContext,
  bodyRegion,
  activityType,
}: {
  caseId: number;
  candidate: string | null | undefined;
  userText: string;
  hypothesis?: string | null;
  movementContext?: string | null;
  bodyRegion?: string | null;
  activityType?: string | null;
}): { finalTest: string; usedFallback: boolean; reason: string | null } {
  const reason = getConcreteTestInvalidReason(candidate);

  if (!reason && candidate) {
    console.log("TEST_VALIDATION_RESULT", {
      caseId,
      valid: true,
      usedFallback: false,
    });
    console.log("TEST_WRITE_READY", {
      caseId,
      preview: candidate.slice(0, 80),
    });

    return { finalTest: candidate, usedFallback: false, reason: null };
  }

  const fallback = buildFallbackConcreteTest({
    userText,
    hypothesis,
    movementContext,
    bodyRegion,
    activityType,
  });
  const fallbackRejectionReason = getAdjustmentContextRejectionReason({
    candidate: fallback,
    userText,
    movementContext,
    bodyRegion,
    activityType,
  });
  const finalFallback = fallbackRejectionReason
    ? `Do 3 slow reps of the movement that triggered it and change one thing: start from the hips before the trunk moves. Tell me what changes.`
    : fallback;

  console.log("TEST_VALIDATION_RESULT", {
    caseId,
    valid: false,
    usedFallback: true,
  });
  console.log("TEST_WRITE_READY", {
    caseId,
    preview: finalFallback.slice(0, 80),
  });
  console.log("CORRECTIVE_ADJUSTMENT_SOURCE", {
    selectedCaseId: caseId,
    adjustmentId: null,
    adjustmentCaseId: caseId,
    source: "deterministic_fallback",
    textPreview: clampText(finalFallback, 180),
    rejectedStaleAdjustment: Boolean(fallbackRejectionReason),
    rejectionReason: fallbackRejectionReason,
  });
  console.log("DRIVE_SERVE_FALLBACK_GUARD", {
    caseId,
    candidatePreview: clampText(fallback, 180),
    explicitDriveServeContext: hasExplicitDriveServeContext(
      userText,
      movementContext,
      bodyRegion,
      activityType,
    ),
    accepted: !fallbackRejectionReason,
    rejectionReason: fallbackRejectionReason,
  });

  return { finalTest: finalFallback, usedFallback: true, reason };
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
  if (!isMechanismLikeText(text)) return false;
  if (isGenericNonMechanicalHypothesis(text)) return false;

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
  ];

  if (directivePatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (vagueInterpretationPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  return (
    /\b(?:because|due to|driven by|caused by|coming from|suggests|indicates|means|points to|breaking|collapsing|stalling|opening too early|shifting too early|losing structure|compensating|taking over|bearing the load|leading to|resulting in|contributing to|which was affecting|at rest leading|irritation|pressure|reduced circulation|reduced mobility|limiting|preventing|inhibiting|restricting)\b/i.test(
      text,
    ) ||
    /\breduced\b[^.!?]{1,80}\bduring\b/i.test(text) ||
    /\bloss of\b[^.!?]{1,80}\bduring\b/i.test(text)
  );
}

function isGenericNonMechanicalHypothesis(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return true;

  const hasGenericCause =
    /\b(?:strain|overuse|repetitive|repetitive use|irritation|soreness|tightness|discomfort)\b/i.test(
      text,
    );
  if (!hasGenericCause) return false;

  const hasMechanicalCause =
    /\b(?:not releasing|absorbing rotation|taking the load|finishing through lumbar extension|sequencing breakdown|trunk and hip release|trunk and hips? release|collapsing under load|opening too early|shifting too early|load is not releasing|rotation is not releasing)\b/i.test(
      text,
    );

  return !hasMechanicalCause;
}

function buildFallbackMechanicalHypothesis({
  activityType,
  movementContext,
  bodyRegion,
}: {
  activityType: string | null | undefined;
  movementContext: string | null | undefined;
  bodyRegion: string | null | undefined;
}): string {
  const activity = normalizeCaseKey(activityType);
  const movement = normalizeCaseKey(movementContext);
  const region = normalizeBodyRegion(bodyRegion);

  if (activity === "golf" && region === "low back") {
    return "Right low back is taking the load because the swing is finishing through lumbar extension instead of hip and trunk rotation.";
  }

  if (
    activity === "racquetball" &&
    /\bserve\b/.test(movement) &&
    (region === "low back" || region === "back")
  ) {
    return "Right low back is absorbing rotation because the load is not releasing cleanly through the trunk and hips during the serve.";
  }

  const readableRegion =
    region && region !== "unspecified"
      ? region === "low back"
        ? "The low back"
        : `The ${region}`
      : "The affected region";
  const movementSource =
    movement && movement !== "unspecified" && !isFallbackMovementContext(movement)
      ? movement
      : activity && activity !== "unspecified"
        ? activity
        : "the movement";
  const readableMovement =
    movementSource === "the movement"
      ? "the movement"
      : `the ${movementSource} pattern`;

  return `${readableRegion} is taking load because ${readableMovement} is not releasing cleanly through the surrounding movement sequence.`;
}

function enforceMechanicalHypothesis({
  original,
  activityType,
  movementContext,
  bodyRegion,
}: {
  original: string | null;
  activityType: string | null | undefined;
  movementContext: string | null | undefined;
  bodyRegion: string | null | undefined;
}): string | null {
  const fallback = buildFallbackMechanicalHypothesis({
    activityType,
    movementContext,
    bodyRegion,
  });
  const accepted = Boolean(original && isStrongHypothesisCandidate(original));
  const finalHypothesis = accepted ? original : fallback;

  console.log("HYPOTHESIS_VALIDATION", {
    original: clampText(original ?? "", 120),
    accepted,
    usedFallback: Boolean(!accepted && fallback),
  });

  return finalHypothesis;
}

function isShallowArcField(
  value: string | null | undefined,
  kind: "interpretationCorrection" | "failurePrediction" | "singleLever",
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return true;

  const genericPatterns = [
    /\bensure\b/i,
    /\bfocus on\b/i,
    /\bfocusing on\b/i,
    /\bwork on\b/i,
    /\btry to\b/i,
    /\btry and\b/i,
    /\bbalance\b/i,
    /\breduce asymmetrical load\b/i,
    /\basymmetrical load\b/i,
    /\bengage\b/i,
    /\bengagement\b/i,
    /\bactivate\b/i,
    /\bactivation\b/i,
    /\bcore\b/i,
    /\bproper form\b/i,
    /\bgood posture\b/i,
    /\bcontrolled rotation\b/i,
    /\bhip rotation initiation\b/i,
    /\bimprove hip rotation\b/i,
    /\btrunk engagement\b/i,
    /\bconsciously engaging\b/i,
    /\bengage the hips\b/i,
    /\bengage the trunk\b/i,
    /\binadequate hip rotation\b/i,
    /\binadequate trunk engagement\b/i,
    /\bincreased right low back strain\b/i,
    /\bnote any change\b/i,
    /\bperform a drive serve\b/i,
    /\bweight transfer\b/i,
    /\bcontinued stiffness\b/i,
    /\bcontinued tightness\b/i,
    /\bcontinued pain\b/i,
    /\bmay persist\b/i,
    /\bmay continue\b/i,
  ];

  if (genericPatterns.some((pattern) => pattern.test(text))) return true;

  if (kind === "interpretationCorrection") {
    const hasContrast =
      /\b(?:not|instead of|rather than|before|after|starting before|starting after|never transfers|doesn'?t transfer)\b/i.test(
        text,
      );
    const hasFailurePoint =
      /\b(?:trunk|hip|hips|back|low back|pelvis|load|transfer|release|rotation|sequence|starts|moves|takes)\b/i.test(
        text,
      );
    return !(hasContrast && hasFailurePoint);
  }

  if (kind === "failurePrediction") {
    const predictsBehavior =
      /\b(?:will|you'll|you will|keeps?|starts?|forces?|takes?|loads?|transfers?|releases?|rotates?|compensates?)\b/i.test(
        text,
      );
    const mechanicalBehavior =
      /\b(?:trunk|hip|hips|back|low back|pelvis|load|transfer|release|rotation|sequence|brace|force)\b/i.test(
        text,
      );
    return !(predictsBehavior && mechanicalBehavior);
  }

  return !hasRealMechanicalLever(text);
}

function buildMechanicalArcDefaults({
  bodyRegion,
  activityType,
  movementContext,
}: {
  bodyRegion: string | null | undefined;
  activityType: string | null | undefined;
  movementContext: string | null | undefined;
}): {
  interpretationCorrection: string;
  failurePrediction: string;
  singleLever: string;
} {
  const activity = normalizeCaseKey(activityType);
  const movement = normalizeCaseKey(movementContext);
  const region = normalizeBodyRegion(bodyRegion);
  const isLowBack = region === "low back" || region === "back";
  const isDriveServe = hasExplicitDriveServeContext(movementContext);

  if (activity === "racquetball" && isDriveServe && isLowBack) {
    return {
      interpretationCorrection:
        "The trunk is starting before the hips, so the serve load is staying in the right low back instead of transferring out through rotation.",
      failurePrediction:
        "If that timing stays the same, the low back will keep forcing the turn instead of the hips starting it.",
      singleLever: "start the turn from the hips before the trunk moves",
    };
  }

  if (activity === "golf" && isLowBack) {
    return {
      interpretationCorrection:
        "Right now the trunk is finishing before the hips clear, so the low back is becoming the release point instead of the hips.",
      failurePrediction:
        "If that sequence stays the same, you will keep forcing the finish from the back instead of letting the hips carry the rotation.",
      singleLever: "clear the hips before the trunk finishes the turn",
    };
  }

  return {
    interpretationCorrection:
      "Right now the trunk is moving before the hips transfer load, so the irritated area is becoming the control point.",
    failurePrediction:
      "If that timing stays the same, the trunk will keep taking the load instead of the hips.",
    singleLever: "start the movement from the hips before the trunk moves",
  };
}

function hasRotationalArcTemplate(value: string | null | undefined): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;

  return (
    /\bdrive[-\s]?serve\b/i.test(text) ||
    /\bturn from (?:your )?hips\b/i.test(text) ||
    /\bstart from (?:your )?hips\b/i.test(text) ||
    /\bhip turn\b/i.test(text) ||
    /\bcore engagement\b/i.test(text) ||
    /\bfocus on stability\b/i.test(text) ||
    /\bstart (?:the )?movement from (?:your )?hips before (?:your )?trunk moves\b/i.test(
      text,
    )
  );
}

function applyControlledStabilityArcRepair(
  arcResult: {
    hypothesis: string | null;
    interpretationCorrection: string | null;
    failurePrediction: string | null;
    singleLever: string | null;
    adjustment: string | null;
    currentTest: string | null;
  },
): void {
  arcResult.interpretationCorrection =
    "As your legs lower, your low back is starting to lift, so the movement is shifting out of your trunk and into your lower back.";
  arcResult.failurePrediction =
    "If that keeps happening, your lower back will keep taking over any time your legs move lower instead of the trunk holding position.";
  arcResult.singleLever =
    "only lower your legs as far as you can without your low back lifting";
  arcResult.adjustment =
    "Lower your legs only as far as you can without your low back lifting off the surface.";
  arcResult.currentTest =
    "Do 3 slow leg-lowering reps and only go as low as you can without your low back lifting. Let me know if the tightness changes.";
}

function applyExtensionDistributionArcRepair(
  arcResult: {
    hypothesis: string | null;
    interpretationCorrection: string | null;
    failurePrediction: string | null;
    singleLever: string | null;
    adjustment: string | null;
    currentTest: string | null;
  },
): void {
  arcResult.interpretationCorrection =
    "As you lift, your lower back is doing too much of the work instead of the lift being distributed through the rest of the body.";
  arcResult.failurePrediction =
    "If that stays the same, your lower back will keep tightening whenever you try to lift higher.";
  arcResult.singleLever =
    "only lift as high as you can without the lower-back tightness increasing";
  arcResult.adjustment =
    "Reduce the lift height and stop before the lower back tightness increases.";
  arcResult.currentTest =
    "Do 3 slow Swan Dive lifts and only lift as high as you can without the lower-back tightness increasing. Let me know if the tightness changes.";
}

function applyOverheadLoadingArcRepair(
  arcResult: {
    hypothesis: string | null;
    interpretationCorrection: string | null;
    failurePrediction: string | null;
    singleLever: string | null;
    adjustment: string | null;
    currentTest: string | null;
  },
): void {
  arcResult.interpretationCorrection =
    "As you reach high and swing hard, the shoulder is getting loaded at the top of the motion instead of the force staying controlled through the shoulder blade and arm path.";
  arcResult.failurePrediction =
    "If that stays the same, the front of the shoulder will keep getting pinched whenever you reach high and swing hard.";
  arcResult.singleLever =
    "keep the spike motion below the point where the front of the shoulder pinches";
  arcResult.adjustment =
    "Reduce the height and force of the overhead spike motion so the front of the shoulder does not pinch.";
  arcResult.currentTest =
    "Do 3 slow overhead spike motions at partial reach. Stop before the front of the shoulder pinches. Let me know if the pinch changes.";
}

function applyPositionalLoadArcRepair(
  arcResult: {
    hypothesis: string | null;
    interpretationCorrection: string | null;
    failurePrediction: string | null;
    singleLever: string | null;
    adjustment: string | null;
    currentTest: string | null;
  },
): void {
  arcResult.interpretationCorrection =
    "The signal is showing up after staying in one position too long, so the irritated area is taking sustained load without enough variation.";
  arcResult.failurePrediction =
    "If that position stays unchanged, the tightness will likely keep building because the load is not being redistributed.";
  arcResult.singleLever = "change position before the tightness builds";
  arcResult.adjustment =
    "Break the position earlier instead of waiting until the tightness is already built up.";
  arcResult.currentTest =
    "For the next sitting or standing block, change position for 30 seconds before the tightness builds. Let me know if the tightness changes.";
}

function applyCompressionOrFoldArcRepair(
  arcResult: {
    hypothesis: string | null;
    interpretationCorrection: string | null;
    failurePrediction: string | null;
    singleLever: string | null;
    adjustment: string | null;
    currentTest: string | null;
  },
): void {
  arcResult.interpretationCorrection =
    "As you go deeper, the hip is closing into a compressed position, which is creating the pinching sensation.";
  arcResult.failurePrediction =
    "If you keep going into that depth, the pinch will continue whenever you reach that bottom position.";
  arcResult.singleLever = "only go as deep as you can without the pinch starting";
  arcResult.adjustment =
    "Reduce the depth of your squat so you stay just above the point where the hip pinches.";
  arcResult.currentTest =
    "Do 3 slow squats and stop just before the hip pinch begins. Let me know if the pinch changes.";
}

function completeArcFields({
  hypothesis,
  interpretationCorrection,
  failurePrediction,
  singleLever,
  adjustment,
  currentTest,
  userText,
  bodyRegion,
  activityType,
  movementContext,
}: {
  hypothesis: string | null;
  interpretationCorrection: string | null;
  failurePrediction: string | null;
  singleLever: string | null;
  adjustment: string | null;
  currentTest: string | null;
  userText: string;
  bodyRegion: string | null | undefined;
  activityType: string | null | undefined;
  movementContext: string | null | undefined;
}): {
  hypothesis: string | null;
  interpretationCorrection: string | null;
  failurePrediction: string | null;
  singleLever: string | null;
  adjustment: string | null;
  currentTest: string | null;
  movementFamily: string;
  mechanicalEnvironment: string;
  failureCandidates: FailurePatternCandidate[];
  dominantFailure: string;
  dominantFailureConfidence: number;
} {
  const normalizedActivity = (activityType || "").toLowerCase();
  const normalizedMovement = (movementContext || "").toLowerCase();
  const normalizedBody = (bodyRegion || "").toLowerCase();
  const normalizedText = (userText || "").toLowerCase();
  const activity = normalizeCaseKey(activityType);
  const movement = normalizeCaseKey(movementContext);
  const region = normalizeBodyRegion(bodyRegion);
  const envResolution = resolveMechanicalEnvironment({
    userText,
    activityType,
    movementContext,
    bodyRegion,
  });
  const env = envResolution.mechanicalEnvironment;
  const movementFamily = classifyMovementFamily(
    userText,
    activityType,
    movementContext,
  );
  const failureResolution = resolveDominantFailurePattern({
    userText,
    activityType,
    movementContext,
    bodyRegion,
    mechanicalEnvironment: env,
  });
  console.log("ARC_ENV_CLASSIFICATION", {
    env,
    features: extractMechanicalFeatures(userText, activityType, movementContext),
    activityType,
    movementContext,
    bodyRegion,
  });
  console.log("MECHANICAL_ENVIRONMENT_RESOLUTION", {
    selectedByPriorityRule: envResolution.selectedByPriorityRule,
    priorityRule: envResolution.priorityRule,
    mechanicalEnvironment: env,
    confidence: envResolution.confidence,
    candidates: envResolution.candidates,
    userTextPreview: clampText(userText, 220),
    activityType,
    movementContext,
    bodyRegion,
  });
  console.log("FAILURE_PATTERN_RESOLUTION", {
    mechanicalEnvironment: env,
    dominantFailure: failureResolution.dominantFailure,
    confidence: failureResolution.confidence,
    candidates: failureResolution.candidates,
  });
  const isDriveServeLowBack =
    normalizedActivity.includes("racquetball") &&
    normalizedBody.includes("back") &&
    (normalizedText.includes("drive serve") ||
      (normalizedText.includes("drive") && normalizedText.includes("serve")));

  const arcResult = {
    hypothesis,
    interpretationCorrection,
    failurePrediction,
    singleLever,
    adjustment,
    currentTest,
    movementFamily,
    mechanicalEnvironment: env,
    failureCandidates: failureResolution.candidates,
    dominantFailure: failureResolution.dominantFailure,
    dominantFailureConfidence: failureResolution.confidence,
  };

  if (
    isDriveServeLowBack &&
    failureResolution.dominantFailure === "sequence_breakdown"
  ) {
    console.log("ARC_DETERMINISTIC_BRANCH_ACTIVE", {
      activityType,
      movementContext,
      bodyRegion,
      userText,
    });
    arcResult.interpretationCorrection =
      "The trunk is starting before the hips, so the rotation is being forced through the low back instead of transferring cleanly.";
    arcResult.failurePrediction =
      "If that timing stays the same, the low back will keep taking the rotational load instead of the hips initiating it.";
    arcResult.singleLever = "start the turn from the hips before the trunk moves";
    arcResult.adjustment =
      "Start the drive-serve turn from your hips before your trunk moves.";
    arcResult.currentTest =
      "Do 3 slow drive-serve motions to the left without a ball. Start the turn from your hips before your trunk moves. Let me know if the stiffness and tightness change.";
    return arcResult;
  }

  if (
    env === "extension_distribution" &&
    failureResolution.dominantFailure === "low_back_dominance"
  ) {
    applyExtensionDistributionArcRepair(arcResult);
    return arcResult;
  }

  if (
    env === "controlled_stability" &&
    failureResolution.dominantFailure === "range_exceeds_control"
  ) {
    applyControlledStabilityArcRepair(arcResult);
    return arcResult;
  }

  if (env === "overhead_loading") {
    applyOverheadLoadingArcRepair(arcResult);
    return arcResult;
  }

  if (env === "positional_load") {
    applyPositionalLoadArcRepair(arcResult);
    return arcResult;
  }

  if (env === "compression_or_fold") {
    applyCompressionOrFoldArcRepair(arcResult);
    return arcResult;
  }

  if (!hypothesis) {
    return arcResult;
  }

  const defaults = buildMechanicalArcDefaults({
    bodyRegion,
    activityType,
    movementContext,
  });

  if (env === "rotational_power") {
    if (isShallowArcField(arcResult.interpretationCorrection, "interpretationCorrection")) {
      arcResult.interpretationCorrection = defaults.interpretationCorrection;
    }

    if (isShallowArcField(arcResult.failurePrediction, "failurePrediction")) {
      arcResult.failurePrediction = defaults.failurePrediction;
    }

    if (isShallowArcField(arcResult.singleLever, "singleLever")) {
      arcResult.singleLever = defaults.singleLever;
    }

    arcResult.adjustment = completeAdjustmentField({
      candidate: arcResult.adjustment,
      hypothesis,
      movementContext: movementContext ?? null,
      bodyRegion: bodyRegion ?? null,
      activityType: activityType ?? null,
    });
    arcResult.currentTest = completeCurrentTestField({
      candidate: arcResult.currentTest ?? arcResult.adjustment,
      userText,
      hypothesis,
      movementContext: movementContext ?? null,
      bodyRegion: bodyRegion ?? null,
      activityType: activityType ?? null,
    });
  } else {
    if (hasRotationalArcTemplate(arcResult.interpretationCorrection)) {
      arcResult.interpretationCorrection = null;
    }
    if (hasRotationalArcTemplate(arcResult.failurePrediction)) {
      arcResult.failurePrediction = null;
    }
    if (hasRotationalArcTemplate(arcResult.singleLever)) {
      arcResult.singleLever = null;
    }
    if (hasRotationalArcTemplate(arcResult.adjustment)) {
      arcResult.adjustment = null;
    }
    if (hasRotationalArcTemplate(arcResult.currentTest)) {
      arcResult.currentTest = null;
    }
  }

  return arcResult;
}

function isStrongAdjustmentCandidate(
  value: string | null | undefined,
): boolean {
  const text = normalizePreviewValue(value);
  if (!text) return false;
  if (text.length < 35) return false;
  if (text.length > 220) return false;
  if (isGenericAdjustmentFillerText(text)) return false;
  if (isGenericCoachingFillerText(text)) return false;
  if (!isTestLikeText(text)) return false;
  if (isMechanismLikeText(text)) return false;
  if (!hasRealMechanicalLever(text)) return false;

  const actionStartPatterns = [
    /^\s*try\b/i,
    /^\s*test\b/i,
    /^\s*use\b/i,
    /^\s*take\b/i,
    /^\s*do\b/i,
    /^\s*walk\b/i,
    /^\s*focus on\b/i,
    /^\s*keep\b/i,
    /^\s*make sure\b/i,
    /^\s*let\b/i,
    /^\s*allow\b/i,
    /^\s*shift\b/i,
    /^\s*load\b/i,
    /^\s*relax\b/i,
    /^\s*drive\b/i,
    /^\s*control\b/i,
    /^\s*rotate\b/i,
    /^\s*stack\b/i,
    /^\s*move\b/i,
    /^\s*press\b/i,
    /^\s*pull\b/i,
    /^\s*push\b/i,
    /^\s*hinge\b/i,
    /^\s*brace\b/i,
    /^\s*stabilize\b/i,
    /^\s*stabilise\b/i,
    /^\s*hold\b/i,
    /^\s*clear\b/i,
    /^\s*stay\b/i,
    /^\s*reduce\b/i,
    /^\s*increase\b/i,
    /^\s*shorten\b/i,
    /^\s*lengthen\b/i,
    /^\s*soften\b/i,
    /^\s*slow\b/i,
  ];

  const rejectMixedPatterns = [
    /\bbecause\b/i,
    /\bdue to\b/i,
    /\bdriven by\b/i,
    /\bcaused by\b/i,
    /\bsuggests\b/i,
    /\bindicates\b/i,
    /\bmeans\b/i,
    /\bthe issue is\b/i,
    /\bthe problem is\b/i,
    /\bthis is happening\b/i,
    /\bwhich means\b/i,
  ];

  const concreteBodyActionPatterns = [
    /\bhip\b/i,
    /\bside\b/i,
    /\brib\b/i,
    /\bpelvis\b/i,
    /\btrunk\b/i,
    /\bshoulder\b/i,
    /\bback\b/i,
    /\bspine\b/i,
    /\bbrace\b/i,
    /\bload\b/i,
    /\bstack\b/i,
    /\brotate\b/i,
    /\bhinge\b/i,
    /\bfoot\b/i,
    /\bfeet\b/i,
    /\bankle\b/i,
    /\bknee\b/i,
    /\bglute\b/i,
    /\bserve\b/i,
    /\bswing\b/i,
    /\bcontact\b/i,
    /\bbackswing\b/i,
    /\bpressure\b/i,
    /\bstride\b/i,
    /\bstep\b/i,
    /\bsteps\b/i,
    /\bgait\b/i,
    /\bwalk\b/i,
    /\bwalking\b/i,
    /\btension\b/i,
    /\brange\b/i,
    /\bposition\b/i,
    /\bspeed\b/i,
    /\btempo\b/i,
  ];

  if (!actionStartPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (rejectMixedPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (!concreteBodyActionPatterns.some((pattern) => pattern.test(text))) {
    return false;
  }

  return true;
}

function isValidMechanicalAdjustmentPair({
  cue,
  mechanicalFocus,
}: {
  cue: string | null | undefined;
  mechanicalFocus: string | null | undefined;
}): boolean {
  const cueText = normalizePreviewValue(cue);
  const mechanicalText = normalizePreviewValue(mechanicalFocus);

  if (!cueText || !mechanicalText) return false;
  if (!isStrongAdjustmentCandidate(cueText)) return false;
  if (!hasRealMechanicalLever(mechanicalText)) return false;
  if (isGenericAdjustmentFillerText(cueText)) return false;
  if (isGenericAdjustmentFillerText(mechanicalText)) return false;
  if (isGenericCoachingFillerText(cueText)) return false;
  if (isGenericCoachingFillerText(mechanicalText)) return false;

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

function areSameAdjustmentText(
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
    "go faster",
    "try it",
    "tried it",
    "helped",
    "that helped",
    "this helped",
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
  bodyRegion?: string | null | undefined,
): string | null {
  const movement = getDisplayableMovementContext(movementContext);
  const activity = getDisplayableActivityType(activityType);
  const region = cleanDashboardTitlePart(bodyRegion);

  if (activity && region) return `${activity} — ${region}`;
  if (movement && region) return `${movement} — ${region}`;
  if (movement && activity) return `${activity} — ${movement}`;
  return movement ?? activity ?? null;
}

function pickDashboardDisplayValue(
  values: Array<string | null | undefined>,
): string | null {
  const normalizedValues = values
    .map((value) => normalizePreviewValue(value))
    .flatMap((value) => (value ?? "").split(/\s+—\s+/))
    .map((value) => normalizePreviewValue(value))
    .filter((value): value is string => Boolean(value));

  if (normalizedValues.length === 0) return null;

  const deduped: string[] = [];

  for (const value of normalizedValues) {
    const existingIndex = deduped.findIndex(
      (existing) =>
        areEquivalentDashboardCandidates(existing, value) ||
        normalizeDashboardCandidate(existing).includes(
          normalizeDashboardCandidate(value),
        ) ||
        normalizeDashboardCandidate(value).includes(
          normalizeDashboardCandidate(existing),
        ),
    );

    if (existingIndex === -1) {
      deduped.push(value);
      continue;
    }

    if (value.length < deduped[existingIndex].length) {
      deduped[existingIndex] = value;
    }
  }

  return deduped.join(" — ") || null;
}

function qualifiesForTimelineSignal(text: string): boolean {
  if (isMovementContextFatigueSignal(text)) return true;

  return /pain|painful|tight|tightness|hurt|hurts|hurting|issue|problem|tweak|tweaked|strain|strained|straining|tension|discomfort|catching|catch|pinch|pinching|pinched|irritated|irritation|sore|soreness|stiff|stiffness|aggravated|aggravating|flare|flaring up|acting up|feels weird|feels wrong|not comfortable|uncomfortable|not sitting right|pulling|tugging|ache|aching|doesn't feel right|doesnt feel right|can't|cannot|struggle|confused|off|feels off|not right|not working|can't rotate|cant rotate|can't load|cant load|timing is off|timing feels off|mechanics feel wrong|movement is weird|doesn't feel stable|not stable|unstable|out of position|can't control|cant control|not coordinated|coordination is off|out of sync|awkward|something is off|rotation feels off|trunk rotation feels wrong/i.test(
    text.trim(),
  );
}

type CaseLaneDecisionReason =
  | "technique_question"
  | "mechanics_discussion"
  | "physical_signal"
  | "performance_breakdown"
  | "fatigue_signal"
  | "outcome_feedback"
  | "unclear";

function classifyCaseLaneDecisionForLog({
  userText,
  shouldCreateCase,
  hasOutcomeFeedback,
}: {
  userText: string;
  shouldCreateCase: boolean;
  hasOutcomeFeedback: boolean;
}): {
  lane: "conversation_only" | "investigation_case";
  reason: CaseLaneDecisionReason;
  confidence: number;
} {
  const text = userText.trim();

  if (hasOutcomeFeedback) {
    return {
      lane: "investigation_case",
      reason: "outcome_feedback",
      confidence: 1,
    };
  }

  if (shouldCreateCase) {
    if (/\b(?:pain|painful|hurt|hurts|hurting|tight|tightness|stiff|stiffness|sore|soreness|ache|aching|discomfort|unstable|instability)\b/i.test(text)) {
      return {
        lane: "investigation_case",
        reason: "physical_signal",
        confidence: 1,
      };
    }

    if (/\b(?:fatigue|fatigued|tired|breakdown|breaks down|los(?:e|ing) control|can't control|cant control|not stable|unstable|off timing|out of sync|awkward|mechanics feel wrong|movement is weird|no power)\b/i.test(text)) {
      return {
        lane: "investigation_case",
        reason: /\b(?:fatigue|fatigued|tired)\b/i.test(text)
          ? "fatigue_signal"
          : "performance_breakdown",
        confidence: 0.7,
      };
    }

    return {
      lane: "investigation_case",
      reason: "physical_signal",
      confidence: 0.7,
    };
  }

  if (/\b(?:what does that mean|mechanic|mechanics|opens? (?:his|her|their)?\s*(?:chest|hips?)|kane|adam|watching|analysis|analyze|theory|why does)\b/i.test(text)) {
    return {
      lane: "conversation_only",
      reason: "mechanics_discussion",
      confidence: 0.7,
    };
  }

  if (/\b(?:where should|how should|what should|contact point|grip|stance|serve|swing|technique|cue|drill)\b/i.test(text)) {
    return {
      lane: "conversation_only",
      reason: "technique_question",
      confidence: 0.7,
    };
  }

  return {
    lane: "conversation_only",
    reason: "unclear",
    confidence: 0.5,
  };
}

function hasOutcomeFeedbackForLaneLog(
  userText: string,
  detectedOutcome: ReturnType<typeof detectOutcomeResult>,
): boolean {
  if (detectedOutcome) return true;

  return /\b(?:tested|tried|did|used)\b.*\b(?:cue|test|drill|adjustment|that|it)\b.*\b(?:changed|better|worse|same|unchanged|different|helped)\b|\b(?:cue|test|drill|adjustment)\b.*\b(?:changed|better|worse|same|unchanged|different|helped)\b/i.test(
    userText.trim(),
  );
}

function getOutcomeRoutingLabels(
  userText: string,
  detectedOutcome: ReturnType<typeof detectOutcomeResult>,
): { logLabel: string; storedResult: string } | null {
  if (detectedOutcome === "Improved") {
    return { logLabel: "improved", storedResult: "improved" };
  }

  if (detectedOutcome === "Worse") {
    return { logLabel: "worse", storedResult: "worse" };
  }

  if (detectedOutcome === "Same") {
    return { logLabel: "unchanged", storedResult: "unchanged" };
  }

  if (/\b(?:changed|different)\b/i.test(userText)) {
    return { logLabel: "changed_unclear", storedResult: "changed_unclear" };
  }

  return null;
}

function getCaseContextMismatchReason({
  candidate,
  latestSignal,
  update,
}: {
  candidate: string | null | undefined;
  latestSignal?: {
    description?: string | null;
    bodyRegion?: string | null;
    movementContext?: string | null;
    activityType?: string | null;
  } | null;
  update: InternalCaseUpdate;
}): string | null {
  const candidateText = normalizePreviewValue(candidate);
  if (!candidateText) return null;

  const contextText = [
    latestSignal?.description,
    latestSignal?.bodyRegion,
    latestSignal?.movementContext,
    latestSignal?.activityType,
    update.signal,
    update.bodyRegion,
    update.movementContext,
    update.activityType,
  ]
    .map((value) => normalizePreviewValue(value))
    .filter(Boolean)
    .join(" ");

  const candidateKey = normalizeCaseKey(candidateText);
  const contextKey = normalizeCaseKey(contextText);
  if (!contextKey) return null;

  if (
    /\bdrive[-\s]?serve\b/i.test(candidateText) &&
    !/\bdrive[-\s]?serve\b/i.test(contextText)
  ) {
    return "candidate_drive_serve_not_in_current_case_context";
  }

  if (
    /\blob\b/i.test(contextText) &&
    /\bdrive[-\s]?serve\b/i.test(candidateText)
  ) {
    return "candidate_drive_serve_conflicts_with_lob_case";
  }

  if (
    /\bshoulder\b/.test(contextKey) &&
    /\b(?:low back|lower back|lumbar)\b/.test(candidateKey)
  ) {
    return "candidate_low_back_language_conflicts_with_shoulder_case";
  }

  return null;
}

function getDashboardSnapshotMismatchReason({
  activeTest,
  selectedCase,
  latestSignal,
}: {
  activeTest: string | null | undefined;
  selectedCase?: {
    movementContext?: string | null;
    activityType?: string | null;
  } | null;
  latestSignal?: {
    description?: string | null;
    bodyRegion?: string | null;
    movementContext?: string | null;
    activityType?: string | null;
  } | null;
}): string | null {
  const candidateText = normalizePreviewValue(activeTest);
  if (!candidateText) return null;

  const contextText = [
    latestSignal?.description,
    latestSignal?.bodyRegion,
    latestSignal?.movementContext,
    latestSignal?.activityType,
    selectedCase?.movementContext,
    selectedCase?.activityType,
  ]
    .map((value) => normalizePreviewValue(value))
    .filter(Boolean)
    .join(" ");

  const candidateKey = normalizeCaseKey(candidateText);
  const contextKey = normalizeCaseKey(contextText);
  if (!contextKey) return null;

  if (
    /\bdrive[-\s]?serve\b/i.test(candidateText) &&
    !/\bdrive[-\s]?serve\b/i.test(contextText)
  ) {
    return "candidate_drive_serve_not_in_selected_case_context";
  }

  if (
    /\blob\b/i.test(contextText) &&
    /\bdrive[-\s]?serve\b/i.test(candidateText)
  ) {
    return "candidate_drive_serve_conflicts_with_lob_case";
  }

  if (
    /\bshoulder\b/.test(contextKey) &&
    /\b(?:low back|lower back|lumbar)\b/.test(candidateKey)
  ) {
    return "candidate_low_back_language_conflicts_with_shoulder_case";
  }

  return null;
}

// ==============================
// OUTCOME DETECTION
// ==============================

function detectOutcomeResult(
  text: string,
): "Improved" | "Worse" | "Same" | null {
  const input = text.trim();

  const improved =
    /\b(helped|worked|better|improved|fixed|that did it|feels better|much better|way better|significantly better|a lot better|relieved|less pain|less tight|lighter|smoother|that helped|this helped|that was helpful|this was helpful|that did help|this did help|you(?:'|\.)?ve been helping me|this has been helping|that has been helping|this is helping|that is helping|that makes sense|this makes sense|makes sense now|that was what i needed|that(?:'|\.)s what i needed|that is what i needed)\b/i;

  const worse =
    /\b(worse|hurt more|hurts more|pain increased|more pain|aggravated|made it worse|tighter|more tight|more strain|more uncomfortable)\b/i;

  const same =
    /\b(no change|same|still the same|didn't help|didnt help|no difference|not different|unchanged)\b/i;

  if (improved.test(input)) return "Improved";
  if (worse.test(input)) return "Worse";
  if (same.test(input)) return "Same";

  return null;
}

function formatStoredOutcomeLabel(
  result: string | null | undefined,
  feedback: string | null | undefined,
): string | null {
  const stored = normalizePreviewValue(result);
  const feedbackText = normalizePreviewValue(feedback);
  const normalizedStored = normalizeCaseKey(stored);
  if (normalizedStored === "mixed") return "Mixed";
  if (normalizedStored === "unchanged") return "Unchanged";

  const combined = [stored, feedbackText].filter(Boolean).join(" ");
  const detected = combined ? detectOutcomeResult(combined) : null;

  if (detected === "Same") return "Unchanged";
  if (detected) return detected;

  return stored ?? null;
}

function formatCaseStatusLabel(status: string | null | undefined): string | null {
  const normalized = normalizeCaseKey(status);
  if (!normalized) return null;

  if (normalized === "open") return "Open";
  if (normalized === "active") return "Active";
  if (normalized === "current") return "Current";
  if (normalized === "resolved") return "Resolved";

  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatInvestigationStateLabel({
  status,
  hasOutcome,
  hasAdjustment,
  hasHypothesis,
}: {
  status: string | null | undefined;
  hasOutcome: boolean;
  hasAdjustment: boolean;
  hasHypothesis: boolean;
}): string | null {
  if (
    String(status ?? "")
      .trim()
      .toLowerCase() === "resolved"
  ) {
    return "Resolved";
  }

  if (hasOutcome || hasAdjustment) return "Testing";
  if (hasHypothesis) return "Narrowing";

  return formatCaseStatusLabel(status);
}

function looksLikeAdjustment(text: string): boolean {
  return /\b(i tried|i changed|i started|i switched|i adjusted|i moved to|i began|i stopped|i reduced|i increased|i focused on|i worked on|i let|i allowed)\b/i.test(
    text.trim(),
  );
}

function looksLikeOutcome(text: string): boolean {
  return /\b(helped|worked|better|improved|worse|hurt more|hurts more|more pain|aggravated|same|no change|didn't help|didnt help|no difference|unchanged|that helped|this helped|that was helpful|this was helpful|that did help|this did help|you(?:'|\.)?ve been helping me|this has been helping|that has been helping|this is helping|that is helping|that makes sense|this makes sense|makes sense now|that was what i needed|that(?:'|\.)s what i needed|that is what i needed)\b/i.test(
    text.trim(),
  );
}

function detectUserClosureSignal(text: string): boolean {
  const input = text.trim();
  if (!input) return false;

  return /\b(thank you|thanks|that helped|this helped|that was helpful|this was helpful|that makes sense|this makes sense|okay that makes sense|got it that helps|understood that helps|perfect|got it|exactly|that was what i needed|that's what i needed|that is what i needed| that’s what i needed|that’s a great plan|that is a great plan|great plan|understood|makes sense now|all good|we're good|we are good|i'm good|im good|all set|that answers it|that answered it|you(?:'|\.)?ve been helping me|this has been helping|that has been helping|this is helping|that is helping)\b/i.test(
    input,
  );
}

// ==============================
// CASE PROGRESSION INTEGRITY HELPERS
// ==============================

type StoredHypothesisRow = {
  id: number;
  hypothesis: string | null;
};

type StoredAdjustmentRow = {
  id: number;
  caseId: number;
  hypothesisId: number | null;
  cue: string | null;
  mechanicalFocus: string | null;
};

function isValidStoredHypothesis(
  row: StoredHypothesisRow | null | undefined,
): row is StoredHypothesisRow {
  return Boolean(row?.id) && isStrongHypothesisCandidate(row?.hypothesis);
}

function isValidStoredAdjustment(
  row: StoredAdjustmentRow | null | undefined,
): row is StoredAdjustmentRow & { hypothesisId: number } {
  return (
    Boolean(row?.id) &&
    typeof row?.hypothesisId === "number" &&
    Number.isFinite(row.hypothesisId) &&
    isValidMechanicalAdjustmentPair({
      cue: row.cue,
      mechanicalFocus: row.mechanicalFocus,
    })
  );
}

async function getLatestValidHypothesisForCase(
  caseId: number,
): Promise<StoredHypothesisRow | null> {
  const hypothesisRows = await db
    .select({
      id: caseHypotheses.id,
      hypothesis: caseHypotheses.hypothesis,
    })
    .from(caseHypotheses)
    .where(eq(caseHypotheses.caseId, caseId))
    .orderBy(desc(caseHypotheses.id))
    .limit(5);

  return hypothesisRows.find((row) => isValidStoredHypothesis(row)) ?? null;
}

async function getLatestValidAdjustmentForCase(
  caseId: number,
): Promise<(StoredAdjustmentRow & { hypothesisId: number }) | null> {
  const adjustmentRows = await db
    .select({
      id: caseAdjustments.id,
      caseId: caseAdjustments.caseId,
      hypothesisId: caseAdjustments.hypothesisId,
      cue: caseAdjustments.cue,
      mechanicalFocus: caseAdjustments.mechanicalFocus,
    })
    .from(caseAdjustments)
    .innerJoin(
      caseHypotheses,
      eq(caseAdjustments.hypothesisId, caseHypotheses.id),
    )
    .where(eq(caseAdjustments.caseId, caseId))
    .orderBy(desc(caseAdjustments.id))
    .limit(8);

  for (const adjustment of adjustmentRows) {
    if (!isValidStoredAdjustment(adjustment)) continue;

    const [hypothesis] = await db
      .select({
        id: caseHypotheses.id,
        hypothesis: caseHypotheses.hypothesis,
      })
      .from(caseHypotheses)
      .where(eq(caseHypotheses.id, adjustment.hypothesisId))
      .limit(1);

    if (isValidStoredHypothesis(hypothesis)) {
      return adjustment;
    }
  }

  return null;
}

async function getValidAdjustmentForOutcomeWrite({
  caseId,
  adjustmentId,
}: {
  caseId: number;
  adjustmentId?: number | null;
}): Promise<(StoredAdjustmentRow & { hypothesisId: number }) | null> {
  if (adjustmentId) {
    const [adjustment] = await db
      .select({
        id: caseAdjustments.id,
        caseId: caseAdjustments.caseId,
        hypothesisId: caseAdjustments.hypothesisId,
        cue: caseAdjustments.cue,
        mechanicalFocus: caseAdjustments.mechanicalFocus,
      })
      .from(caseAdjustments)
      .innerJoin(
        caseHypotheses,
        eq(caseAdjustments.hypothesisId, caseHypotheses.id),
      )
      .where(
        and(
          eq(caseAdjustments.id, adjustmentId),
          eq(caseAdjustments.caseId, caseId),
        ),
      )
      .limit(1);

    if (!isValidStoredAdjustment(adjustment)) return null;

    const [hypothesis] = await db
      .select({
        id: caseHypotheses.id,
        hypothesis: caseHypotheses.hypothesis,
      })
      .from(caseHypotheses)
      .where(eq(caseHypotheses.id, adjustment.hypothesisId))
      .limit(1);

    return isValidStoredHypothesis(hypothesis) ? adjustment : null;
  }

  return getLatestValidAdjustmentForCase(caseId);
}

async function getLatestOutcomeForCase(caseId: number): Promise<{
  id: number;
  result: string | null;
  userFeedback: string | null;
  adjustmentId: number | null;
} | null> {
  const [outcome] = await db
    .select({
      id: caseOutcomes.id,
      result: caseOutcomes.result,
      userFeedback: caseOutcomes.userFeedback,
      adjustmentId: caseOutcomes.adjustmentId,
    })
    .from(caseOutcomes)
    .where(eq(caseOutcomes.caseId, caseId))
    .orderBy(desc(caseOutcomes.id))
    .limit(1);

  return outcome ?? null;
}

type InternalOutcomeStatus =
  | "improved"
  | "worse"
  | "same"
  | "unknown"
  | null;

type FailurePatternCandidate = {
  failure: string;
  score: number;
  evidence: string[];
};

type InternalCaseUpdate = {
  signal: string | null;
  bodyRegion: string | null;
  activityType: string | null;
  movementContext: string | null;
  sportDomain: string | null;
  activityMovement: string | null;
  movementFamily: string | null;
  mechanicalEnvironment: string | null;
  failureCandidates: FailurePatternCandidate[];
  dominantFailure: string | null;
  dominantFailureConfidence: number | null;
  activeLever: string | null;
  activeTest: string | null;
  hypothesis: string | null;
  interpretationCorrection: string | null;
  failurePrediction: string | null;
  singleLever: string | null;
  adjustment: string | null;
  currentTest: string | null;
  outcome: string | null;
  outcomeStatus: InternalOutcomeStatus;
  shouldStartNewCase: boolean;
  matchedCaseId?: number | null;
  confidence: number;
};

type InternalCasePersistResult = {
  attempted: boolean;
  wroteHypothesis: boolean;
  wroteAdjustment: boolean;
  wroteOutcome: boolean;
  update: InternalCaseUpdate | null;
};

function parseJsonObjectFromText(text: string): Record<string, unknown> | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;

  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;

    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function stringOrNull(value: unknown, max = 600): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /^null$/i.test(trimmed)) return null;
  return clampText(trimmed, max);
}

function normalizeInternalOutcomeStatus(value: unknown): InternalOutcomeStatus {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "improved") return "improved";
  if (normalized === "worse") return "worse";
  if (normalized === "same") return "same";
  if (normalized === "unknown") return "unknown";
  return null;
}

function normalizeInternalConfidence(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : 0;

  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function completeCurrentTestField({
  candidate,
  userText,
  hypothesis,
  movementContext,
  bodyRegion,
  activityType,
}: {
  candidate: string | null;
  userText: string;
  hypothesis: string | null;
  movementContext: string | null;
  bodyRegion: string | null;
  activityType: string | null;
}): string | null {
  if (!hypothesis) return candidate;
  if (!getConcreteTestInvalidReason(candidate)) return candidate;

  return buildFallbackConcreteTest({
    userText,
    hypothesis,
    movementContext,
    bodyRegion,
    activityType,
  });
}

function completeAdjustmentField({
  candidate,
  hypothesis,
  movementContext,
  bodyRegion,
  activityType,
}: {
  candidate: string | null;
  hypothesis: string | null;
  movementContext: string | null;
  bodyRegion: string | null;
  activityType: string | null;
}): string | null {
  if (!hypothesis) return candidate;

  const activity = normalizeCaseKey(activityType);
  const movement = normalizeCaseKey(movementContext);
  const region = normalizeBodyRegion(bodyRegion);

  if (
    activity === "racquetball" &&
    hasExplicitDriveServeContext(movementContext) &&
    (region === "low back" || region === "back") &&
    (!candidate ||
      isGenericAdjustmentFillerText(candidate) ||
      isWeakTestInstructionText(candidate) ||
      isShallowArcField(candidate, "singleLever"))
  ) {
    return "Start the drive-serve turn from the hips before the trunk moves.";
  }

  if (
    !candidate ||
    isGenericAdjustmentFillerText(candidate) ||
    isWeakTestInstructionText(candidate) ||
    isShallowArcField(candidate, "singleLever")
  ) {
    return "Start the movement from the hips before the trunk moves.";
  }

  return candidate;
}

function normalizeInternalCaseUpdate(
  raw: Record<string, unknown> | null,
  fallback: {
    userText: string;
    derivedBodyRegion: string | null;
    derivedActivityType: string | null;
    derivedMovementContext: string | null;
    outcomeResult: "Improved" | "Worse" | "Same" | null;
  },
): InternalCaseUpdate {
  const userText = fallback.userText;
  const outcomeStatusFromDetector =
    fallback.outcomeResult === "Improved"
      ? "improved"
      : fallback.outcomeResult === "Worse"
        ? "worse"
        : fallback.outcomeResult === "Same"
          ? "same"
          : null;
  const rawBodyRegion =
    stringOrNull(raw?.bodyRegion, 80) ?? fallback.derivedBodyRegion ?? null;
  const normalizedBodyRegion = rawBodyRegion
    ? normalizeBodyRegion(rawBodyRegion)
    : null;
  const normalizedActivityType =
    stringOrNull(raw?.activityType, 80) ??
    fallback.derivedActivityType ??
    null;
  let normalizedMovementContext =
    normalizeExtractedContextCandidate(stringOrNull(raw?.movementContext, 80)) ??
    normalizeExtractedContextCandidate(fallback.derivedMovementContext) ??
    null;
  if (normalizeCaseKey(normalizedActivityType) === "golf") {
    normalizedMovementContext = "golf swing";
  } else if (
    normalizeCaseKey(normalizedActivityType) === "racquetball" &&
    /\bdrive[-\s]?serve|drive serves\b/i.test(
      `${userText} ${normalizedMovementContext ?? ""}`,
    )
  ) {
    normalizedMovementContext = "drive serve";
  }
  const rawHypothesis = stringOrNull(raw?.hypothesis, 400);
  const enforcedHypothesis = enforceMechanicalHypothesis({
    original: rawHypothesis,
    activityType: normalizedActivityType,
    movementContext: normalizedMovementContext,
    bodyRegion: normalizedBodyRegion,
  });
  const normalizedCorrection = stringOrNull(
    raw?.interpretationCorrection,
    260,
  );
  const normalizedFailurePrediction = stringOrNull(
    raw?.failurePrediction,
    260,
  );
  const normalizedSingleLever = stringOrNull(raw?.singleLever, 180);
  const rawFieldQuality = {
    hypothesis: enforcedHypothesis,
    interpretationCorrection: normalizedCorrection,
    failurePrediction: normalizedFailurePrediction,
    singleLever: normalizedSingleLever,
    adjustment: stringOrNull(raw?.adjustment, 320),
    currentTest: stringOrNull(raw?.currentTest, 320),
  };
  console.log("ARC_FIELD_QUALITY_BEFORE", rawFieldQuality);
  const arcResult = completeArcFields({
    hypothesis: enforcedHypothesis,
    interpretationCorrection: normalizedCorrection,
    failurePrediction: normalizedFailurePrediction,
    singleLever: normalizedSingleLever,
    adjustment: rawFieldQuality.adjustment,
    currentTest: rawFieldQuality.currentTest,
    userText: userText,
    bodyRegion: normalizedBodyRegion,
    activityType: normalizedActivityType,
    movementContext: normalizedMovementContext,
  });
  console.log("ARC_FIELD_QUALITY_AFTER", arcResult);
  const sportDomain = deriveSportDomainForAnalytics(
    userText,
    normalizedActivityType,
  );
  const activityMovement = deriveActivityMovementForAnalytics(
    userText,
    normalizedMovementContext,
  );
  console.log("SPORT_DOMAIN_EXTRACTION", {
    sportDomain,
    activityMovement,
    activityType: normalizedActivityType,
    movementContext: normalizedMovementContext,
  });

  const update: InternalCaseUpdate = {
    signal:
      stringOrNull(raw?.signal, 800) ??
      (qualifiesForTimelineSignal(userText)
        ? clampText(userText, 800)
        : null),
    bodyRegion: normalizedBodyRegion,
    activityType: normalizedActivityType,
    movementContext: normalizedMovementContext,
    sportDomain,
    activityMovement,
    movementFamily: arcResult.movementFamily,
    mechanicalEnvironment: arcResult.mechanicalEnvironment,
    failureCandidates: arcResult.failureCandidates,
    dominantFailure: arcResult.dominantFailure,
    dominantFailureConfidence: arcResult.dominantFailureConfidence,
    activeLever: arcResult.singleLever,
    activeTest: arcResult.currentTest,
    hypothesis: arcResult.hypothesis,
    interpretationCorrection: arcResult.interpretationCorrection,
    failurePrediction: arcResult.failurePrediction,
    singleLever: arcResult.singleLever,
    adjustment: arcResult.adjustment,
    currentTest: arcResult.currentTest,
    outcome: stringOrNull(raw?.outcome, 400),
    outcomeStatus:
      normalizeInternalOutcomeStatus(raw?.outcomeStatus) ??
      outcomeStatusFromDetector,
    shouldStartNewCase: raw?.shouldStartNewCase === true,
    matchedCaseId:
      typeof raw?.matchedCaseId === "number" && Number.isFinite(raw.matchedCaseId)
        ? raw.matchedCaseId
        : null,
    confidence: normalizeInternalConfidence(raw?.confidence),
  };

  console.log("ARC_COMPLETION_RESULT", {
    hypothesis: update.hypothesis,
    interpretationCorrection: update.interpretationCorrection,
    failurePrediction: update.failurePrediction,
    singleLever: update.singleLever,
    movementFamily: update.movementFamily,
    mechanicalEnvironment: update.mechanicalEnvironment,
    dominantFailure: update.dominantFailure,
    dominantFailureConfidence: update.dominantFailureConfidence,
  });

  return update;
}

async function buildInternalCaseStateSnapshot(caseId: number): Promise<{
  latestSignal: string | null;
  latestHypothesis: string | null;
  latestAdjustment: string | null;
  latestOutcome: string | null;
}> {
  const [latestSignal] = await db
    .select({ description: caseSignals.description })
    .from(caseSignals)
    .where(eq(caseSignals.caseId, caseId))
    .orderBy(desc(caseSignals.id))
    .limit(1);
  const latestHypothesis = await getLatestValidHypothesisForCase(caseId);
  const latestAdjustment = await getLatestValidAdjustmentForCase(caseId);
  const latestOutcome = await getLatestOutcomeForCase(caseId);

  return {
    latestSignal: latestSignal?.description ?? null,
    latestHypothesis: latestHypothesis?.hypothesis ?? null,
    latestAdjustment: latestAdjustment
      ? pickDashboardDisplayValue([
          latestAdjustment.cue,
          latestAdjustment.mechanicalFocus,
        ])
      : null,
    latestOutcome: latestOutcome
      ? [latestOutcome.result, latestOutcome.userFeedback]
          .filter(Boolean)
          .join(": ")
      : null,
  };
}

async function persistCaseReasoningSnapshot({
  caseId,
  signalId,
  activeHypothesisId,
  activeAdjustmentId,
  update,
}: {
  caseId: number;
  signalId?: number | null;
  activeHypothesisId?: number | null;
  activeAdjustmentId?: number | null;
  update: InternalCaseUpdate;
}): Promise<number | null> {
  try {
    const [snapshot] = await db
      .insert(caseReasoningSnapshots)
      .values({
        caseId,
        signalId: signalId ?? null,
        activeHypothesisId: activeHypothesisId ?? null,
        activeAdjustmentId: activeAdjustmentId ?? null,
        sportDomain: update.sportDomain,
        activityMovement: update.activityMovement,
        bodyRegion: update.bodyRegion,
        movementFamily: update.movementFamily,
        mechanicalEnvironment: update.mechanicalEnvironment,
        failureCandidates: update.failureCandidates,
        dominantFailure: update.dominantFailure,
        dominantFailureConfidence: update.dominantFailureConfidence,
        activeLever: update.activeLever,
        activeTest: update.activeTest,
        interpretationCorrection: update.interpretationCorrection,
        failurePrediction: update.failurePrediction,
      })
      .returning({ id: caseReasoningSnapshots.id });

    console.log("CASE_REASONING_SNAPSHOT_WRITE", {
      caseId,
      snapshotId: snapshot?.id ?? null,
      movementFamily: update.movementFamily,
      mechanicalEnvironment: update.mechanicalEnvironment,
      dominantFailure: update.dominantFailure,
      dominantFailureConfidence: update.dominantFailureConfidence,
      activeLeverPreview: clampText(update.activeLever ?? "", 160),
      activeTestPreview: clampText(update.activeTest ?? "", 220),
      interpretationCorrectionPreview: clampText(
        update.interpretationCorrection ?? "",
        220,
      ),
      failurePredictionPreview: clampText(update.failurePrediction ?? "", 220),
    });

    return snapshot?.id ?? null;
  } catch (err) {
    console.error("CASE_REASONING_SNAPSHOT_WRITE_FAILED", {
      caseId,
      ...formatUnknownError(err),
    });
    return null;
  }
}

async function runInternalCaseEngine({
  openaiClient,
  traceId,
  userText,
  currentCase,
  derivedBodyRegion,
  derivedActivityType,
  derivedMovementContext,
  derivedSignalType,
  outcomeResult,
}: {
  openaiClient: OpenAI;
  traceId?: string | null;
  userText: string;
  currentCase: ResolvedCaseRow;
  derivedBodyRegion: string | null;
  derivedActivityType: string | null;
  derivedMovementContext: string | null;
  derivedSignalType: string | null;
  outcomeResult: "Improved" | "Worse" | "Same" | null;
}): Promise<InternalCaseUpdate> {
  const priorState = await buildInternalCaseStateSnapshot(currentCase.id);
  const messagesForInternalPass: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `
You are Coreloop's internal case engine.

Return only strict JSON. No markdown. No explanation.

Your job is structured case state, not user-facing language.
Read the new user input and current case state, then produce the next structured state update.

Rules:
- Extract the real signal from the user input.
- Keep the update scoped to the current case.
- If the user reports an outcome, preserve the existing mechanism and refine the next test.
- Generate a concise internal hypothesis when enough evidence exists.
- The hypothesis must be mechanical, not generic strain/overuse/irritation/tightness.
- Do not output generic injury labels as hypotheses. "Possible strain", "overuse", "repetitive use", "irritation", "soreness", "tightness", or "discomfort" are invalid unless paired with a mechanical cause.
- Every hypothesis must answer what is physically happening: load, release, rotation, sequencing, timing, spacing, compensation, collapse, structure, hip/trunk transfer, lumbar extension, weight shift, or fatigue changing mechanics.
- If activity is golf and bodyRegion is low back, consider rotation/load/release/fatigue mechanics.
- If activity is racquetball serve and bodyRegion is low back, consider load/release/rotation sequencing.
- Generate interpretationCorrection, failurePrediction, and singleLever when enough evidence exists.
- Generate one movement-based adjustment/currentTest when enough information exists.
- Do not prescribe training, strengthening, exercise programs, sets, or routines.
- currentTest should be an in-movement probe or lever, not a paragraph.
- If information is missing, use null instead of inventing.

JSON shape:
{
  "signal": string | null,
  "bodyRegion": string | null,
  "activityType": string | null,
  "movementContext": string | null,
  "hypothesis": string | null,
  "interpretationCorrection": string | null,
  "failurePrediction": string | null,
  "singleLever": string | null,
  "adjustment": string | null,
  "currentTest": string | null,
  "outcome": string | null,
  "outcomeStatus": "improved" | "worse" | "same" | "unknown" | null,
  "shouldStartNewCase": boolean,
  "matchedCaseId": number | null,
  "confidence": number
}
      `.trim(),
    },
    {
      role: "user",
      content: JSON.stringify({
        userInput: userText,
        currentCase: {
          id: currentCase.id,
          movementContext: currentCase.movementContext,
          activityType: currentCase.activityType,
          status: currentCase.status,
        },
        deterministicSignalRead: {
          bodyRegion: derivedBodyRegion,
          activityType: derivedActivityType,
          movementContext: derivedMovementContext,
          signalType: derivedSignalType,
          outcomeResult,
        },
        priorCaseState: priorState,
      }),
    },
  ];

  const rawText = await runCompletion(openaiClient, messagesForInternalPass);
  logLayer1Trace(traceId, "raw_internal_case_engine_output", {
    caseId: currentCase.id,
    rawPreview: clampText(rawText, 1200),
  });
  const parsed = parseJsonObjectFromText(rawText);

  if (!parsed) {
    console.warn("INTERNAL_CASE_ENGINE_PARSE_FAILED", {
      caseId: currentCase.id,
      rawPreview: clampText(rawText, 240),
    });
  }

  const update = normalizeInternalCaseUpdate(parsed, {
    userText,
    derivedBodyRegion,
    derivedActivityType,
    derivedMovementContext,
    outcomeResult,
  });
  logLayer1Trace(traceId, "normalized_internal_update", {
    caseId: currentCase.id,
    update,
  });

  console.log("LAYER1_OUTPUT", {
    caseId: currentCase.id,
    bodyRegion: update.bodyRegion,
    activity: update.activityType,
    sportDomain: update.sportDomain,
    activityMovement: update.activityMovement,
    movementFamily: update.movementFamily,
    mechanicalEnvironment: update.mechanicalEnvironment,
    dominantFailure: update.dominantFailure,
    dominantFailureConfidence: update.dominantFailureConfidence,
    hypothesis: clampText(update.hypothesis ?? "", 120),
    interpretationCorrection: clampText(
      update.interpretationCorrection ?? "",
      120,
    ),
    failurePrediction: clampText(update.failurePrediction ?? "", 120),
    singleLever: clampText(update.singleLever ?? "", 120),
    adjustment: clampText(update.adjustment ?? "", 120),
    currentTest: clampText(update.currentTest ?? "", 120),
    outcome: clampText(update.outcome ?? "", 120),
    outcomeStatus: update.outcomeStatus,
  });

  return update;
}

async function persistInternalCaseUpdate({
  userId,
  traceId,
  caseId,
  update,
  userText,
}: {
  userId: string;
  traceId?: string | null;
  caseId: number;
  update: InternalCaseUpdate;
  userText: string;
}): Promise<InternalCasePersistResult> {
  const result: InternalCasePersistResult = {
    attempted: true,
    wroteHypothesis: false,
    wroteAdjustment: false,
    wroteOutcome: false,
    update,
  };

  const [latestSignal] = await db
    .select({
      id: caseSignals.id,
      description: caseSignals.description,
      bodyRegion: caseSignals.bodyRegion,
      movementContext: caseSignals.movementContext,
      activityType: caseSignals.activityType,
    })
    .from(caseSignals)
    .where(eq(caseSignals.caseId, caseId))
    .orderBy(desc(caseSignals.id))
    .limit(1);

  if (
    update.signal &&
    !areEquivalentDashboardCandidates(update.signal, latestSignal?.description)
  ) {
    await writeCaseSignalIfNew({
      userId,
      caseId,
      description: update.signal,
      activityType: update.activityType ?? "unspecified",
      movementContext: update.movementContext ?? "general movement",
      bodyRegion: update.bodyRegion,
      signalType: null,
    });
  }

  const [activeSignal] = await db
    .select({ id: caseSignals.id })
    .from(caseSignals)
    .where(eq(caseSignals.caseId, caseId))
    .orderBy(desc(caseSignals.id))
    .limit(1);
  const activeSignalId = activeSignal?.id ?? latestSignal?.id ?? null;

  let activeHypothesis = await getLatestValidHypothesisForCase(caseId);
  let activeAdjustmentId =
    (await getLatestValidAdjustmentForCase(caseId))?.id ?? null;
  let activeAdjustmentText = update.currentTest ?? update.adjustment ?? null;
  let activeTestSource = update.currentTest
    ? "layer1_currentTest"
    : update.adjustment
      ? "layer1_adjustment"
      : null;
  let rejectedStaleActiveTest = false;
  let rejectedStaleSourceCaseId: number | null = null;
  const hypothesisValidation = {
    hasHypothesis: Boolean(update.hypothesis),
    isStrongCandidate: update.hypothesis
      ? isStrongHypothesisCandidate(update.hypothesis)
      : false,
    preview: clampText(update.hypothesis ?? "", 220),
  };
  logLayer1Trace(traceId, "hypothesis_validation_result", {
    caseId,
    ...hypothesisValidation,
  });

  if (update.hypothesis && isStrongHypothesisCandidate(update.hypothesis)) {
    const [latestStoredHypothesis] = await db
      .select({
        id: caseHypotheses.id,
        hypothesis: caseHypotheses.hypothesis,
      })
      .from(caseHypotheses)
      .where(eq(caseHypotheses.caseId, caseId))
      .orderBy(desc(caseHypotheses.id))
      .limit(1);

    if (
      !areEquivalentDashboardCandidates(
        update.hypothesis,
        latestStoredHypothesis?.hypothesis,
      )
    ) {
      const [insertedHypothesis] = await db
        .insert(caseHypotheses)
        .values({
          caseId,
          signalId: activeSignalId,
          hypothesis: update.hypothesis,
          confidence: String(update.confidence || 0.65),
        })
        .returning({
          id: caseHypotheses.id,
          hypothesis: caseHypotheses.hypothesis,
        });

      activeHypothesis = insertedHypothesis;
      result.wroteHypothesis = true;
      console.log("INTERNAL_HYPOTHESIS_WRITE", {
        caseId,
        status: "inserted",
        hypothesisId: insertedHypothesis?.id ?? null,
        hypothesisPreview: clampText(update.hypothesis, 180),
      });
      console.log("INTERNAL_CASE_WRITE_SUCCESS", {
        type: "hypothesis",
        caseId,
        hypothesisId: insertedHypothesis?.id ?? null,
      });
    } else if (isValidStoredHypothesis(latestStoredHypothesis)) {
      activeHypothesis = latestStoredHypothesis;
      console.log("INTERNAL_HYPOTHESIS_WRITE", {
        caseId,
        status: "duplicate_reused_latest",
        hypothesisId: latestStoredHypothesis.id,
        hypothesisPreview: clampText(update.hypothesis, 180),
      });
    } else {
      console.log("INTERNAL_HYPOTHESIS_WRITE", {
        caseId,
        status: "duplicate_skipped_latest_invalid",
        hypothesisPreview: clampText(update.hypothesis, 180),
      });
    }
  } else {
    console.log("INTERNAL_HYPOTHESIS_WRITE", {
      caseId,
      status: update.hypothesis ? "skipped_generic_or_invalid" : "skipped_null",
      hypothesisPreview: clampText(update.hypothesis ?? "", 180),
    });
  }

  const nextTest = update.currentTest ?? update.adjustment;
  const testInvalidReason = getConcreteTestInvalidReason(nextTest);
  logLayer1Trace(traceId, "adjustment_test_candidate_precheck", {
    caseId,
    hasNextTest: Boolean(nextTest),
    hasActiveHypothesis: Boolean(activeHypothesis?.id),
    candidatePreview: clampText(nextTest ?? "", 220),
    candidateValid: testInvalidReason === null,
    invalidReason: testInvalidReason,
  });

  if (activeHypothesis?.id) {
    const testValidationResult = enforceConcreteTestCandidate({
      caseId,
      candidate: nextTest,
      userText,
      hypothesis: activeHypothesis.hypothesis,
      movementContext: update.movementContext,
      bodyRegion: update.bodyRegion,
      activityType: update.activityType,
    });
    let { finalTest } = testValidationResult;
    activeTestSource = testValidationResult.usedFallback
      ? "current_case_fallback"
      : activeTestSource;
    logLayer1Trace(traceId, "adjustment_test_validation_result", {
      caseId,
      hasNextTest: Boolean(nextTest),
      hasActiveHypothesis: true,
      candidatePreview: clampText(nextTest ?? "", 220),
      finalTestPreview: clampText(finalTest, 220),
      finalTestValid: isValidConcreteTest(finalTest),
      usedFallback: testValidationResult.usedFallback,
      invalidReason: testValidationResult.reason,
    });
    const testContextMismatchReason =
      getAdjustmentContextRejectionReason({
        candidate: finalTest,
        userText,
        movementContext: update.movementContext,
        bodyRegion: update.bodyRegion,
        activityType: update.activityType,
      }) ??
      getCaseContextMismatchReason({
        candidate: finalTest,
        latestSignal,
        update,
      });
    console.log("ADJUSTMENT_WRITE_CONTEXT_GUARD", {
      caseId,
      movementContext: update.movementContext,
      activityType: update.activityType,
      bodyRegion: update.bodyRegion,
      candidatePreview: clampText(finalTest ?? "", 180),
      accepted: !testContextMismatchReason,
      rejectionReason: testContextMismatchReason,
    });

    if (testContextMismatchReason) {
      rejectedStaleActiveTest = true;
      rejectedStaleSourceCaseId = null;
      activeAdjustmentText = null;
      activeAdjustmentId = null;
      activeTestSource = "rejected_context_mismatch";
      console.warn("SNAPSHOT_WRITE_FIELD_ISOLATION", {
        caseId,
        activeTestPreview: clampText(finalTest ?? "", 180),
        activeTestSource,
        rejectedStaleActiveTest,
        rejectedStaleSourceCaseId,
        reason: testContextMismatchReason,
      });
    } else {
      activeAdjustmentText = finalTest;
    }

    const adjustmentCue = activeAdjustmentText;
    const mechanicalFocus = activeAdjustmentText;

    const [latestStoredAdjustment] = await db
      .select({
        id: caseAdjustments.id,
        cue: caseAdjustments.cue,
        mechanicalFocus: caseAdjustments.mechanicalFocus,
      })
      .from(caseAdjustments)
      .where(eq(caseAdjustments.caseId, caseId))
      .orderBy(desc(caseAdjustments.id))
      .limit(1);

    const isDuplicateAdjustment =
      Boolean(adjustmentCue) &&
      (areSameAdjustmentText(adjustmentCue, latestStoredAdjustment?.cue) ||
        areSameAdjustmentText(
          mechanicalFocus,
          latestStoredAdjustment?.mechanicalFocus,
        ));

    if (activeAdjustmentText && !isDuplicateAdjustment) {
      const [insertedAdjustment] = await db
        .insert(caseAdjustments)
        .values({
          caseId,
          hypothesisId: activeHypothesis.id,
          adjustmentType: "internal_case_engine",
          cue: adjustmentCue,
          mechanicalFocus,
        })
        .returning({ id: caseAdjustments.id });

      activeAdjustmentId = insertedAdjustment?.id ?? null;
      result.wroteAdjustment = true;
      console.log("INTERNAL_ADJUSTMENT_WRITE", {
        caseId,
        status: "inserted",
        adjustmentId: insertedAdjustment?.id ?? null,
        hypothesisId: activeHypothesis.id,
        cuePreview: clampText(adjustmentCue ?? "", 180),
        mechanicalFocusPreview: clampText(mechanicalFocus ?? "", 180),
      });
      console.log("INTERNAL_CASE_WRITE_SUCCESS", {
        type: "adjustment",
        caseId,
        adjustmentId: insertedAdjustment?.id ?? null,
      });
      if (latestStoredAdjustment?.id) {
        console.log("INTERNAL_ADJUSTMENT_REPLACED_ACTIVE", {
          caseId,
          previousAdjustmentId: latestStoredAdjustment.id,
          newAdjustmentId: insertedAdjustment?.id ?? null,
          previousPreview: clampText(
            pickDashboardDisplayValue([
              latestStoredAdjustment.cue,
              latestStoredAdjustment.mechanicalFocus,
            ]) ?? "",
            180,
          ),
          newPreview: clampText(
            pickDashboardDisplayValue([adjustmentCue, mechanicalFocus]) ?? "",
            180,
          ),
        });
      }
    } else {
      console.log("INTERNAL_ADJUSTMENT_WRITE", {
        caseId,
        status: activeAdjustmentText
          ? "duplicate_skipped"
          : "skipped_stale_or_null_test",
        adjustmentId: latestStoredAdjustment?.id ?? null,
        hypothesisId: activeHypothesis.id,
        cuePreview: clampText(adjustmentCue ?? "", 180),
        mechanicalFocusPreview: clampText(mechanicalFocus ?? "", 180),
      });
      activeAdjustmentId = activeAdjustmentText
        ? latestStoredAdjustment?.id ?? null
        : null;
    }
  } else {
    logLayer1Trace(traceId, "adjustment_test_validation_result", {
      caseId,
      hasNextTest: Boolean(nextTest),
      hasActiveHypothesis: false,
      candidatePreview: clampText(nextTest ?? "", 220),
      finalTestPreview: "",
      finalTestValid: false,
      usedFallback: false,
      invalidReason: activeHypothesis?.id
        ? testInvalidReason
        : "skipped_no_active_hypothesis",
    });
    console.log("INTERNAL_ADJUSTMENT_WRITE", {
      caseId,
      status: "skipped_no_hypothesis",
      hasNextTest: Boolean(nextTest),
      hasActiveHypothesis: Boolean(activeHypothesis?.id),
      nextTestPreview: clampText(nextTest ?? "", 180),
    });
  }

  if (activeAdjustmentText && !rejectedStaleActiveTest) {
    const snapshotTestMismatchReason =
      getAdjustmentContextRejectionReason({
        candidate: activeAdjustmentText,
        userText,
        movementContext: update.movementContext,
        bodyRegion: update.bodyRegion,
        activityType: update.activityType,
      }) ??
      getCaseContextMismatchReason({
        candidate: activeAdjustmentText,
        latestSignal,
        update,
      });

    console.log("ADJUSTMENT_WRITE_CONTEXT_GUARD", {
      caseId,
      movementContext: update.movementContext,
      activityType: update.activityType,
      bodyRegion: update.bodyRegion,
      candidatePreview: clampText(activeAdjustmentText ?? "", 180),
      accepted: !snapshotTestMismatchReason,
      rejectionReason: snapshotTestMismatchReason,
    });

    if (snapshotTestMismatchReason) {
      const rejectedActiveTestPreview = activeAdjustmentText;
      rejectedStaleActiveTest = true;
      rejectedStaleSourceCaseId = null;
      activeAdjustmentText = null;
      activeAdjustmentId = null;
      activeTestSource = "rejected_context_mismatch";
      console.warn("SNAPSHOT_WRITE_FIELD_ISOLATION", {
        caseId,
        activeTestPreview: clampText(rejectedActiveTestPreview ?? "", 180),
        activeTestSource,
        rejectedStaleActiveTest,
        rejectedStaleSourceCaseId,
        reason: snapshotTestMismatchReason,
      });
    }
  }

  if (!rejectedStaleActiveTest) {
    console.log("SNAPSHOT_WRITE_FIELD_ISOLATION", {
      caseId,
      activeTestPreview: clampText(activeAdjustmentText ?? "", 180),
      activeTestSource,
      rejectedStaleActiveTest,
      rejectedStaleSourceCaseId,
    });
  }

  if (rejectedStaleActiveTest) {
    console.log("SNAPSHOT_TEST_REJECTED_ONLY", {
      caseId,
      activeTestRejected: true,
      preservedFields: [
        "movementFamily",
        "mechanicalEnvironment",
        "dominantFailure",
        "activeLever",
        "interpretationCorrection",
        "failurePrediction",
      ],
    });
  }

  await persistCaseReasoningSnapshot({
    caseId,
    signalId: activeSignalId,
    activeHypothesisId: activeHypothesis?.id ?? null,
    activeAdjustmentId,
    update: {
      ...update,
      movementFamily: update.movementFamily,
      mechanicalEnvironment: update.mechanicalEnvironment,
      dominantFailure: update.dominantFailure,
      activeLever: update.singleLever,
      activeTest: rejectedStaleActiveTest ? null : activeAdjustmentText,
      interpretationCorrection: update.interpretationCorrection,
      failurePrediction: update.failurePrediction,
    },
  });

  if (update.outcomeStatus && update.outcomeStatus !== "unknown") {
    const mappedOutcome =
      update.outcomeStatus === "improved"
        ? "improved"
        : update.outcomeStatus === "worse"
          ? "worse"
          : "unchanged";
    const validAdjustment = await getValidAdjustmentForOutcomeWrite({ caseId });

    if (validAdjustment) {
      const [latestOutcome] = await db
        .select({
          id: caseOutcomes.id,
          result: caseOutcomes.result,
          adjustmentId: caseOutcomes.adjustmentId,
          createdAt: caseOutcomes.createdAt,
        })
        .from(caseOutcomes)
        .where(eq(caseOutcomes.adjustmentId, validAdjustment.id))
        .orderBy(desc(caseOutcomes.id))
        .limit(1);

      const latestCreatedAtMs = latestOutcome?.createdAt
        ? new Date(latestOutcome.createdAt).getTime()
        : 0;
      const isDuplicateRecentOutcome =
        Boolean(latestOutcome) &&
        latestOutcome?.result === mappedOutcome &&
        latestOutcome?.adjustmentId === validAdjustment.id &&
        latestCreatedAtMs > 0 &&
        Date.now() - latestCreatedAtMs <= 1000 * 60 * 10;

      if (!isDuplicateRecentOutcome) {
        const [insertedOutcome] = await db
          .insert(caseOutcomes)
          .values({
            caseId,
            adjustmentId: validAdjustment.id,
            result: mappedOutcome,
            userFeedback: update.outcome ?? null,
          })
          .returning({ id: caseOutcomes.id });

        result.wroteOutcome = true;
        console.log("INTERNAL_OUTCOME_WRITE", {
          caseId,
          status: "inserted",
          outcomeId: insertedOutcome?.id ?? null,
          adjustmentId: validAdjustment.id,
          result: mappedOutcome,
        });
        console.log("INTERNAL_CASE_WRITE_SUCCESS", {
          type: "outcome",
          caseId,
          outcomeId: insertedOutcome?.id ?? null,
        });

        if (mappedOutcome === "improved") {
          await db
            .update(cases)
            .set({ status: "resolved" })
            .where(eq(cases.id, caseId));
        }
      } else {
        console.log("INTERNAL_OUTCOME_WRITE", {
          caseId,
          status: "duplicate_recent_skipped",
          adjustmentId: validAdjustment.id,
          result: mappedOutcome,
        });
      }
    } else {
      console.log("INTERNAL_OUTCOME_WRITE", {
        caseId,
        status: "skipped_no_valid_adjustment",
        result: mappedOutcome,
      });
    }
  } else {
    console.log("INTERNAL_OUTCOME_WRITE", {
      caseId,
      status: update.outcomeStatus ? "skipped_unknown" : "skipped_null",
      outcomeStatus: update.outcomeStatus,
    });
  }

  await db.update(cases).set({ updatedAt: new Date() }).where(eq(cases.id, caseId));
  logLayer1Trace(traceId, "persistence_result", {
    caseId,
    attempted: result.attempted,
    wroteHypothesis: result.wroteHypothesis,
    wroteAdjustment: result.wroteAdjustment,
    wroteOutcome: result.wroteOutcome,
  });

  return result;
}

async function buildStructuredCaseStateBlock(
  caseId: number,
  internalUpdate: InternalCaseUpdate | null,
  traceId?: string | null,
  isNewCase = false,
): Promise<string> {
  const snapshot = await buildInternalCaseStateSnapshot(caseId);
  const visibleStateInput = {
    caseId,
    signal:
      internalUpdate?.signal ??
      (isNewCase ? null : snapshot.latestSignal) ??
      null,
    bodyRegion: internalUpdate?.bodyRegion ?? null,
    activityType: internalUpdate?.activityType ?? null,
    movementContext: internalUpdate?.movementContext ?? null,
    hypothesis:
      internalUpdate?.hypothesis ??
      (isNewCase ? null : snapshot.latestHypothesis) ??
      null,
    interpretationCorrection: internalUpdate?.interpretationCorrection ?? null,
    failurePrediction: internalUpdate?.failurePrediction ?? null,
    singleLever: internalUpdate?.singleLever ?? null,
    adjustment:
      internalUpdate?.currentTest ??
      internalUpdate?.adjustment ??
      (isNewCase ? null : snapshot.latestAdjustment) ??
      null,
    outcome:
      internalUpdate?.outcome ??
      (isNewCase ? null : snapshot.latestOutcome) ??
      null,
  };

  console.log("VISIBLE_RESPONSE_INPUT", {
    caseId,
    hasHypothesis: Boolean(visibleStateInput.hypothesis),
    hasAdjustment: Boolean(visibleStateInput.adjustment),
    hasCurrentTest: Boolean(visibleStateInput.adjustment),
  });
  console.log("ARC_SINGLE_SOURCE_CHECK", {
    source: "completeArcFields",
    hypothesis: visibleStateInput.hypothesis,
    interpretationCorrection: visibleStateInput.interpretationCorrection,
    failurePrediction: visibleStateInput.failurePrediction,
    singleLever: visibleStateInput.singleLever,
    adjustment: internalUpdate?.adjustment ?? null,
    currentTest: internalUpdate?.currentTest ?? null,
  });
  logLayer1Trace(traceId, "final_structured_case_state_for_layer2", {
    caseId,
    snapshot,
    visibleStateInput,
  });

  return `
=== STRUCTURED CASE STATE ===
This is the internal case engine state. Use it as source-of-truth context.
The visible response must express the Arc when a hypothesis exists.

Selective output is allowed only when no hypothesis is present.

If hypothesis exists:
- include mechanism
- include at least one of correction or failure prediction
- include one lever or test

Signal: ${visibleStateInput.signal ?? "none"}
Body region: ${visibleStateInput.bodyRegion ?? "unknown"}
Activity: ${visibleStateInput.activityType ?? "unknown"}
Movement context: ${visibleStateInput.movementContext ?? "unknown"}
Current hypothesis: ${visibleStateInput.hypothesis ?? "none"}
Interpretation correction: ${
    visibleStateInput.interpretationCorrection ?? "none"
  }
Failure prediction: ${visibleStateInput.failurePrediction ?? "none"}
Single lever: ${visibleStateInput.singleLever ?? "none"}
Current adjustment/test: ${visibleStateInput.adjustment ?? "none"}
Latest outcome: ${visibleStateInput.outcome ?? "none"}

Response rule:
- Speak from this structured state.
- Do not write for extraction.
- The visible response is the Arc. It should naturally express signal, mechanism, correction, failure prediction, lever, and test when the state supports them.
- Do not output only the test unless the correct response type is single-test/probe.
- Select the next useful user-facing move: breakdown, tight correction, lever, probe, or clarification.
`;
}

async function getVisibleCurrentTestFromCaseState(
  caseId: number,
  internalUpdate: InternalCaseUpdate | null,
): Promise<string | null> {
  return normalizePreviewValue(
    internalUpdate?.currentTest ??
      internalUpdate?.adjustment ??
      null,
  ) || null;
}

function responseIncludesCurrentTest(
  responseText: string,
  currentTest: string,
): boolean {
  const responseNormalized = normalizeDashboardCandidate(responseText);
  const testNormalized = normalizeDashboardCandidate(currentTest);

  if (!responseNormalized || !testNormalized) return false;

  return (
    responseNormalized.includes(testNormalized) ||
    testNormalized.includes(responseNormalized) ||
    areEquivalentDashboardCandidates(responseText, currentTest)
  );
}

function isProbeOnlyResponse(text: string): boolean {
  const normalized = normalizePreviewValue(text);
  if (!normalized) return true;

  return (
    normalized.length < 140 &&
    /\?$/.test(normalized) &&
    !/\b(?:do|take|try|test)\s+(?:1|one|2|two|3|three|5|five)\b/i.test(
      normalized,
    )
  );
}

function isTestOnlyResponse(text: string, currentTest: string): boolean {
  const normalized = normalizePreviewValue(text);
  if (!normalized) return true;

  const startsWithTestAction =
    /^(?:take|do|try|test)\s+(?:1|one|3|three|5|five)\b/i.test(normalized);
  const hasObservationCue =
    /\b(?:tell me if|starts during|during load, rotation, or after release)\b/i.test(
      normalized,
    );

  if (startsWithTestAction && hasObservationCue) return true;
  if (!responseIncludesCurrentTest(normalized, currentTest)) return false;

  const withoutTest = normalizeDashboardCandidate(normalized).replace(
    normalizeDashboardCandidate(currentTest),
    "",
  );

  return withoutTest.replace(/\s+/g, " ").trim().length < 80;
}

function hasOutcomeFeedbackClosure(text: string): boolean {
  return /\b(?:let me know|tell me|report back|what changed|what changes|better,\s*worse,\s*or\s*the\s*same|if it changes|whether it changes|whether it feels|what happens after|what happens with|how it feels after)\b/i.test(
    text,
  );
}

function stripVisibleLayer1Labels(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.replace(
        /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Dominant failure|Mechanical environment|Failure prediction|Interpretation correction|Active lever|Active test)(?:\*\*)?\s*:\s*/i,
        "",
      ),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripStructuredLayer2Labels(text: string): {
  text: string;
  stripped: boolean;
} {
  const strippedText = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d+[\.)])\s+/, "")
        .replace(
          /^\s*(?:\*\*)?(?:Mechanism|Correction|Lever|Failure Prediction|Active Test)(?:\*\*)?\s*:\s*/i,
          "",
        )
        .replace(
          /^\s*(?:Here's what's likely happening|Here's a refined look|To address this|Try this)\s*:\s*/i,
          "",
        ),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: strippedText,
    stripped: strippedText !== text.trim(),
  };
}

function firstSentence(text: string | null | undefined): string | null {
  const normalized = normalizePreviewValue(text);
  if (!normalized) return null;

  return normalized.split(/(?<=[.!?])\s+/)[0]?.trim() || null;
}

function appendLayer2Sentence(text: string, sentence: string): string {
  const trimmedText = text.trim();
  const trimmedSentence = sentence.trim();
  if (!trimmedSentence) return trimmedText;

  if (!trimmedText) return trimmedSentence;

  return `${trimmedText}\n\n${trimmedSentence}`;
}

function containsLayer2CoachingBleed(text: string): boolean {
  const normalized = normalizePreviewValue(text) ?? "";
  if (!normalized) return false;

  if (/^\s*(?:[-*•]|\d+[\.)])\s+/m.test(normalized)) return true;

  if (
    /\b(?:also|in addition|another thing|consider|make sure|keep an eye on|recovery routine|recovery|pacing|general fitness|monitor)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  if (
    /^\s*(?:[-*•]|\d+[\.)])?\s*(?:\*\*)?(?:Mechanism|Correction|Lever|Failure Prediction|Active Test)(?:\*\*)?\s*:/im.test(
      normalized,
    )
  ) {
    return true;
  }

  if (/\bfocus on\b.+\band\b.+/i.test(normalized)) return true;

  const instructionMatches = normalized.match(
    /\b(?:try|do|start|keep|focus|monitor|work on|consider|make sure|add|avoid|pace|recover|practice|address)\b/gi,
  );

  return (instructionMatches?.length ?? 0) > 2;
}

function isLikelyLayer2InstructionParagraph(text: string): boolean {
  const normalized = normalizePreviewValue(text) ?? "";
  if (!normalized) return false;

  const stripped = stripStructuredLayer2Labels(normalized).text;

  return (
    /^\s*(?:[-*•]|\d+[\.)])\s+/m.test(normalized) ||
    /\b(?:try|do|start|keep|focus|monitor|work on|consider|make sure|keep an eye on|add|avoid|pace|recover|practice|also|in addition|another thing|recovery|pacing)\b/i.test(
      stripped,
    )
  );
}

function enforceSingleLever({
  text,
  activeLever,
  activeTest,
}: {
  text: string;
  activeLever?: string | null;
  activeTest?: string | null;
}): { text: string; modified: boolean; reason?: string } {
  const normalizedActiveLever = normalizePreviewValue(activeLever);
  if (!normalizedActiveLever) {
    return { text, modified: false };
  }

  const originalText = text.trim();
  if (!containsLayer2CoachingBleed(originalText)) {
    return { text: originalText, modified: false };
  }

  const mechanismParagraph = originalText
    .split(/\n{2,}/)
    .flatMap((paragraph) => paragraph.split("\n"))
    .map((paragraph) => stripStructuredLayer2Labels(paragraph.trim()).text)
    .filter(Boolean)
    .filter((paragraph) => !isLikelyLayer2InstructionParagraph(paragraph))
    .filter(
      (paragraph) =>
        !areEquivalentDashboardCandidates(paragraph, normalizedActiveLever),
    )
    .map((paragraph) => firstSentence(paragraph) ?? paragraph)
    .find(Boolean);

  const nextParts = [
    ...(mechanismParagraph ? [mechanismParagraph] : []),
    normalizedActiveLever,
  ];
  const normalizedActiveTest = normalizePreviewValue(activeTest);

  if (
    normalizedActiveTest &&
    !responseIncludesCurrentTest(nextParts.join("\n\n"), normalizedActiveTest)
  ) {
    nextParts.push(normalizedActiveTest);
  }

  let finalText = nextParts.join("\n\n").trim();

  if (normalizedActiveTest && !hasOutcomeFeedbackClosure(finalText)) {
    finalText = appendLayer2Sentence(
      finalText,
      "Let me know whether it feels better, worse, or the same.",
    );
  }

  return {
    text: finalText,
    modified: finalText !== originalText,
    reason: "multi_instruction_detected",
  };
}

function cleanCoachingLanguage(text: string): {
  text: string;
  cleaned: boolean;
} {
  let cleanedText = text.trim();

  const replacements: Array<[RegExp, string]> = [
    [/\btry focusing on\b/gi, "start"],
    [/\bfocus on initiating\b/gi, "start"],
    [/\bfocus on starting\b/gi, "start"],
    [/\bfocus on\b/gi, "use"],
    [/\bmake sure to use your hips\b/gi, "use your hips"],
    [/\bmake sure your hips are involved\b/gi, "use your hips first"],
    [/\bmake sure to\b/gi, ""],
    [/\bmake sure\b/gi, ""],
    [/\bconsider\b/gi, ""],
    [/\bkeep an eye on\b/gi, "notice"],
    [/\bit might help to\b/gi, ""],
  ];

  for (const [pattern, replacement] of replacements) {
    cleanedText = cleanedText.replace(pattern, replacement);
  }

  cleanedText = cleanedText
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text: cleanedText,
    cleaned: cleanedText !== text.trim(),
  };
}

function detectNonEnglishOutput(text: string): boolean {
  const normalized = normalizePreviewValue(text) ?? "";
  if (!normalized) return false;

  const nonLatinMatches = normalized.match(
    /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g,
  );
  const nonLatinCount = nonLatinMatches?.length ?? 0;

  return nonLatinCount >= 3 || nonLatinCount / normalized.length > 0.05;
}

function buildEnglishLayer2Fallback({
  interpretationCorrection,
  hypothesis,
  activeLever,
  activeTest,
}: {
  interpretationCorrection?: string | null;
  hypothesis?: string | null;
  activeLever?: string | null;
  activeTest?: string | null;
}): string {
  const parts = [
    firstSentence(interpretationCorrection) ??
      firstSentence(hypothesis) ??
      "This looks like a movement mechanics issue.",
    normalizePreviewValue(activeLever),
    normalizePreviewValue(activeTest),
    "Let me know whether it feels better, worse, or the same.",
  ].filter((value): value is string => Boolean(value));

  return parts.join("\n\n");
}

function enforceOutcomeFeedbackExpression({
  text,
  outcomeResult,
}: {
  text: string;
  outcomeResult: ReturnType<typeof detectOutcomeResult>;
}): { text: string; modified: boolean } {
  if (!outcomeResult) return { text, modified: false };

  const fallbackByOutcome: Record<NonNullable<ReturnType<typeof detectOutcomeResult>>, string> = {
    Improved:
      "Good. That means the load is shifting in the right direction. Stay with that for now and notice how it holds up under play.",
    Worse:
      "Got it. That version is not the right lever for this case. Leave that cue alone for now and use the change as useful signal.",
    Same:
      "Good data. That cue did not change the signal, so it probably is not the main lever. Do not keep repeating that same test for now.",
  };

  const compressedText = fallbackByOutcome[outcomeResult];

  return {
    text: compressedText,
    modified: compressedText !== text.trim(),
  };
}

function enforceLayer2BehavioralCompleteness({
  text,
  hypothesis,
  interpretationCorrection,
  failurePrediction: _failurePrediction,
  activeLever: _activeLever,
  activeTest,
}: {
  text: string;
  hypothesis?: string | null;
  interpretationCorrection?: string | null;
  failurePrediction?: string | null;
  activeLever?: string | null;
  activeTest?: string | null;
}): {
  text: string;
  repaired: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  let finalText = stripVisibleLayer1Labels(text);

  if (finalText !== text.trim()) {
    reasons.push("stripped_visible_layer1_labels");
  }

  const normalizedHypothesis = normalizePreviewValue(hypothesis);
  const normalizedCorrection = normalizePreviewValue(interpretationCorrection);
  const normalizedActiveTest = normalizePreviewValue(activeTest);

  if (!normalizedHypothesis && !normalizedActiveTest) {
    return {
      text: finalText,
      repaired: reasons.length > 0,
      reasons,
    };
  }

  const mechanismSource =
    firstSentence(normalizedCorrection) ?? firstSentence(normalizedHypothesis);
  const hasMechanism =
    Boolean(
      normalizedCorrection &&
        areEquivalentDashboardCandidates(finalText, normalizedCorrection),
    ) ||
    Boolean(
      normalizedHypothesis &&
        areEquivalentDashboardCandidates(finalText, normalizedHypothesis),
    ) ||
    Boolean(
      mechanismSource &&
        normalizeDashboardCandidate(finalText).includes(
          normalizeDashboardCandidate(mechanismSource),
        ),
    );

  if (
    normalizedHypothesis &&
    normalizedActiveTest &&
    mechanismSource &&
    (!hasMechanism || isTestOnlyResponse(finalText, normalizedActiveTest))
  ) {
    finalText = `${mechanismSource}\n\n${finalText}`.trim();
    reasons.push(
      isTestOnlyResponse(text, normalizedActiveTest)
        ? "prepended_mechanism_for_test_only_response"
        : "prepended_missing_mechanism",
    );
  }

  if (
    normalizedActiveTest &&
    !responseIncludesCurrentTest(finalText, normalizedActiveTest)
  ) {
    finalText = appendLayer2Sentence(finalText, normalizedActiveTest);
    reasons.push("appended_missing_active_test");
  }

  if (normalizedActiveTest && !hasOutcomeFeedbackClosure(finalText)) {
    finalText = appendLayer2Sentence(
      finalText,
      "Let me know whether it feels better, worse, or the same.",
    );
    reasons.push("appended_outcome_feedback_closure");
  }

  return {
    text: finalText,
    repaired: reasons.length > 0,
    reasons,
  };
}

async function buildSessionSummaryContext({
  userId,
  conversationId,
  userText,
  finalText,
  resolvedActiveCase,
  isCaseReview,
}: {
  userId: string;
  conversationId: number;
  userText: string;
  finalText: string;
  resolvedActiveCase: ResolvedCaseRow | null;
  isCaseReview: boolean;
}): Promise<string[]> {
  const context: string[] = [
    `Latest user message: ${clampText(userText, 1200)}`,
    `Latest assistant response: ${clampText(finalText, 1600)}`,
    `Case review turn: ${isCaseReview ? "yes" : "no"}`,
    `User signaled closure: ${detectUserClosureSignal(userText) ? "yes" : "no"}`,
  ];

  let activeCase = resolvedActiveCase;

  if (!activeCase) {
    activeCase = await getConversationOpenCase(userId, conversationId);
  }

  if (!activeCase) {
    context.push("Active case: none tied to this session turn.");
    context.push("Unresolved state: no active case evidence available.");
    return context;
  }

  const activeCaseTitle = buildActiveCaseTitle(
    activeCase.movementContext,
    activeCase.activityType,
  );
  const latestHypothesis = await getLatestValidHypothesisForCase(activeCase.id);
  const latestAdjustment = await getLatestValidAdjustmentForCase(activeCase.id);
  const latestOutcome = await getLatestOutcomeForCase(activeCase.id);
  const isResolved =
    String(activeCase.status ?? "")
      .trim()
      .toLowerCase() === "resolved" ||
    detectOutcomeResult(
      `${String(latestOutcome?.result ?? "")} ${String(
        latestOutcome?.userFeedback ?? "",
      )}`.trim(),
    ) === "Improved";

  context.push(`Active case id: ${activeCase.id}`);
  context.push(
    `Active case title: ${
      activeCaseTitle ||
      [activeCase.activityType, activeCase.movementContext]
        .filter(Boolean)
        .join(" / ") ||
      "unknown"
    }`,
  );
  context.push(
    `Movement/activity context: ${[
      activeCase.movementContext,
      activeCase.activityType,
    ]
      .filter(Boolean)
      .join(" / ")}`,
  );
  context.push(
    `Latest valid hypothesis: ${
      latestHypothesis?.hypothesis?.trim() || "none recorded"
    }`,
  );
  context.push(
    `Latest valid adjustment/test: ${
      latestAdjustment
        ? [
            latestAdjustment.cue?.trim(),
            latestAdjustment.mechanicalFocus?.trim(),
          ]
            .filter(Boolean)
            .join(" — ")
        : "none recorded"
    }`,
  );
  context.push(
    `Latest outcome: ${
      latestOutcome
        ? [latestOutcome.result?.trim(), latestOutcome.userFeedback?.trim()]
            .filter(Boolean)
            .join(": ")
        : "none recorded"
    }`,
  );
  context.push(
    `Unresolved state: ${
      isResolved
        ? "resolved or improved"
        : latestAdjustment
          ? "test/adjustment is still active unless the user clearly resolved it"
          : latestHypothesis
            ? "mechanism is active/forming but no valid adjustment has been captured"
            : "investigation remains open"
    }`,
  );

  return context;
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

async function getActiveHypothesisBlock(
  userId: string,
  caseId?: number | null,
): Promise<string> {
  const unresolved = await db
    .select({
      caseId: caseAdjustments.caseId,
      adjustmentId: caseAdjustments.id,
      cue: caseAdjustments.cue,
      mechanicalFocus: caseAdjustments.mechanicalFocus,
    })
    .from(caseAdjustments)
    .innerJoin(cases, eq(caseAdjustments.caseId, cases.id))
    .innerJoin(
      caseHypotheses,
      eq(caseAdjustments.hypothesisId, caseHypotheses.id),
    )
    .leftJoin(caseOutcomes, eq(caseAdjustments.id, caseOutcomes.adjustmentId))
    .where(
      and(
        eq(cases.userId, userId),
        isNull(caseOutcomes.id),
        ...(caseId ? [eq(cases.id, caseId)] : []),
      ),
    )
    .orderBy(desc(caseAdjustments.id))
    .limit(5);

  const latest = unresolved.find((row) =>
    isValidMechanicalAdjustmentPair({
      cue: row.cue,
      mechanicalFocus: row.mechanicalFocus,
    }),
  );

  if (!latest) return "";

  return `
=== ACTIVE HYPOTHESIS (PRIORITY) ===
Use this only if the current user signal clearly belongs to the same case.
If the current signal shifts body region, movement context, activity, or signal type, do not force continuity and do not explain it through this hypothesis.

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

function getResponseArcViolationReasons(text: string): string[] {
  const reasons: string[] = [];

  if (!text?.trim()) return ["empty_response"];

  const normalized = text.toLowerCase();
  const isSingleRepProbe =
    /\b(?:do|try|test|repeat)\s+one\b/.test(normalized) ||
    /\bone\s+(?:rep|slow|controlled|brief)\b/.test(normalized) ||
    /\bonce\b/.test(normalized) ||
    /\bone[-\s]?time\b/.test(normalized);

  const genericCoachPatterns = [
    { label: "focus_on_exercises", pattern: /\bfocus on exercises\b/ },
    { label: "focus_on_strengthening", pattern: /\bfocus on strengthening\b/ },
    { label: "work_on", pattern: /\bwork on\b/ },
    { label: "strengthen", pattern: /\bstrengthen\b/ },
    { label: "improve_stability", pattern: /\bimprove stability\b/ },
    { label: "improve_control", pattern: /\bimprove control\b/ },
    { label: "perform_exercise", pattern: /\bperform .*exercise\b/ },
    { label: "do_exercise", pattern: /\bdo .*exercises?\b/ },
    {
      label: "sets_or_programming",
      pattern: /\b\d+\s*sets?\b|\bsets\b|\breps\b|\bprogram\b|\broutine\b/,
    },
    { label: "practice_drill", pattern: /\bpractice\b/ },
  ];

  for (const entry of genericCoachPatterns) {
    if (entry.pattern.test(normalized)) {
      reasons.push(`banned_coach_language:${entry.label}`);
    }
  }

  if (isWeakTestInstructionText(text)) {
    reasons.push("weak_test_instruction");
  }

  const movementProbePatterns = [
    { label: "single_leg_bridge", pattern: /\bsingle[-\s]?leg bridge\b/ },
    { label: "bridge", pattern: /\bbridge\b/ },
    { label: "wall_slide", pattern: /\bwall slide\b/ },
    { label: "drill", pattern: /\bdrills?\b/ },
    { label: "marching", pattern: /\bmarching\b/ },
    { label: "step_down", pattern: /\bstep[-\s]?down\b/ },
    { label: "stair_step", pattern: /\bstair step\b|\bstep from a stair\b/ },
  ];

  for (const entry of movementProbePatterns) {
    if (entry.pattern.test(normalized) && !isSingleRepProbe) {
      reasons.push(`banned_coach_language:${entry.label}_prescription`);
    }
  }

  if (
    /\bhigher speeds\b|\bas speed increases\b|\bwhen you go faster\b|\bfaster movement\b/i.test(
      text,
    )
  ) {
    reasons.push("generic_failure_localization");
  }

  if (
    /\bthe issue is\b/i.test(text) &&
    /\bthe issue is\b[\s\S]{0,260}\bthe issue is\b/i.test(text)
  ) {
    reasons.push("repeated_template_language");
  }

  if (/\bthe issue is that your\b[^.!?]{0,140}\bagain\b/i.test(text)) {
    reasons.push("repeated_explanation_iteration_failure");
  }

  if (text.length > 850) reasons.push("too_long");

  return reasons;
}

function violatesResponseArc(text: string): boolean {
  return getResponseArcViolationReasons(text).length > 0;
}

function containsBannedCoachLanguage(text: string): boolean {
  return getResponseArcViolationReasons(text).some((reason) =>
    reason.startsWith("banned_coach_language:"),
  );
}

type ExtractableResponseType = "investigation" | "case_review" | "system";

function classifyAssistantResponseForExtraction({
  isCaseReview,
  text,
}: {
  isCaseReview: boolean;
  text: string;
}): ExtractableResponseType {
  if (isCaseReview) return "case_review";

  const normalized = String(text ?? "").trim();

  if (
    /---\s*(?:KEY DEVELOPMENTS OVER TIME|ORIGIN PROBLEM)\s*---/i.test(
      normalized,
    ) ||
    /\bcase review\b/i.test(normalized)
  ) {
    return "case_review";
  }

  if (/^I am Coreloop\./i.test(normalized)) {
    return "system";
  }

  return "investigation";
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

async function getDominantRuntimePatternBlock(
  userId: string,
  caseId?: number | null,
): Promise<string> {
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
    .where(
      caseId
        ? and(eq(cases.userId, userId), eq(cases.id, caseId))
        : eq(cases.userId, userId),
    )
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
          hypothesisId: caseAdjustments.hypothesisId,
        })
        .from(caseAdjustments)
        .innerJoin(
          caseHypotheses,
          eq(caseAdjustments.hypothesisId, caseHypotheses.id),
        )
        .where(eq(caseAdjustments.caseId, caseRow.id))
        .orderBy(desc(caseAdjustments.id))
        .limit(1);

      const outcomes = await db
        .select({
          id: caseOutcomes.id,
          result: caseOutcomes.result,
          userFeedback: caseOutcomes.userFeedback,
          adjustmentId: caseOutcomes.adjustmentId,
        })
        .from(caseOutcomes)
        .innerJoin(
          caseAdjustments,
          eq(caseOutcomes.adjustmentId, caseAdjustments.id),
        )
        .innerJoin(
          caseHypotheses,
          eq(caseAdjustments.hypothesisId, caseHypotheses.id),
        )
        .where(eq(caseOutcomes.caseId, caseRow.id))
        .orderBy(desc(caseOutcomes.id))
        .limit(3);

      const validHypotheses = hypotheses.filter((h) =>
        isValidStoredHypothesis(h),
      );
      const validAdjustments = adjustments.filter((a) =>
        isValidStoredAdjustment({
          caseId: caseRow.id,
          id: a.id,
          hypothesisId: a.hypothesisId,
          cue: a.cue,
          mechanicalFocus: a.mechanicalFocus,
        }),
      );

      const signalCount = signals.length;
      const hypothesisCount = validHypotheses.length;
      const adjustmentCount = validAdjustments.length;
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
        hypotheses: validHypotheses,
        adjustments: validAdjustments,
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
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "capacitor://localhost");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }

    next();
  });

  await setupAuth(app);

  registerAnalyticsRoutes(app);

  await ensureProfileImagesDirectory();
  app.use(
    "/uploads",
    express.static(UPLOADS_ROOT_DIR, {
      fallthrough: true,
      index: false,
    }),
  );

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/api/version", (_req: Request, res: Response) => {
    res.json({
      backendVersion: "test-enforcement-v4-no-candidate-failed-validation",
      version: "diagnostic-v2",
      commit: "230014a1656f8bd004f63eba72701c2c9206ec28",
    });
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

      res.json(
        buildPersistedSettings(
          userRecord?.firstName,
          memory,
          (userRecord as any)?.profileImageUrl,
        ),
      );
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

      const existingMemory = await getMemory(userId);
      const existingMemoryWithPreferences =
        existingMemory as typeof existingMemory & {
          preferences?: {
            voice?: unknown;
          };
        };
      const existingVoice =
        typeof existingMemoryWithPreferences.preferences?.voice === "string" &&
        existingMemoryWithPreferences.preferences.voice in
          INTERLOOP_SETTINGS_VOICE_IDS
          ? (existingMemoryWithPreferences.preferences
              .voice as PersistedInterloopVoice)
          : null;

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
      const profileImageUrl =
        typeof body.profileImageUrl === "string" && body.profileImageUrl.trim()
          ? body.profileImageUrl.trim()
          : null;

      await db
        .update(users)
        .set({
          firstName: name,
          email: authUser?.claims?.email ?? null,
          ...(profileImageUrl ? { profileImageUrl } : {}),
        })
        .where(eq(users.id, userId));

      if (existingVoice !== voice) {
        try {
          await db.execute(
            sql`
              INSERT INTO voice_change_events (user_id, from_voice, to_voice)
              VALUES (${userId}, ${existingVoice}, ${voice})
            `,
          );
        } catch (err) {
          console.error("Failed to log voice change event:", err);
        }
      }

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

      const [updatedUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      res.json(
        buildPersistedSettings(
          name,
          updatedMemory,
          (updatedUser as any)?.profileImageUrl ?? profileImageUrl,
        ),
      );
    } catch (err) {
      console.error("Failed to save settings:", err);
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  app.post(
    "/api/upload-profile-image",
    isAuthenticated,
    async (req: any, res: Response) => {
      try {
        const authUser = req.user as any;
        const userId = authUser?.claims?.sub;

        if (!userId) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        const file = await readMultipartProfileImage(req);

        if (!file) {
          return res.status(400).json({ error: "Invalid file" });
        }

        if (file.buffer.length > 2 * 1024 * 1024) {
          return res
            .status(400)
            .json({ error: "File size must be 2MB or less" });
        }

        const extension = getProfileImageExtension(file);

        if (!extension) {
          return res.status(400).json({ error: "File must be JPG or PNG" });
        }

        const filename = `${userId}-${Date.now()}.${extension}`;

        const url = await uploadProfileImageToStorage(
          userId,
          filename,
          file.buffer,
          extension === "png" ? "image/png" : "image/jpeg",
        );

        res.json({ url });
      } catch (err) {
        if (err instanceof Error && err.message === "FILE_TOO_LARGE") {
          return res
            .status(400)
            .json({ error: "File size must be 2MB or less" });
        }

        console.error("Profile image upload failed:", err);
        res.status(500).json({ error: "Profile image upload failed" });
      }
    },
  );

  app.post("/api/stt", async (req: Request, res: Response) => {
    const sttStartedAt = Date.now();
    let sttMimeType = "unknown";
    let sttExtension = "unknown";
    let sttInputPath: string | undefined;
    let sttOutputPath: string | undefined;
    let sttFailureDetails = "Unknown STT failure";
    let sttInputBytes = 0;

    try {
      const { audio, mimeType } = req.body ?? {};

      if (!audio) {
        return res.status(400).json({ error: "No audio provided" });
      }

      const resolvedMimeType =
        typeof mimeType === "string" && mimeType.trim()
          ? mimeType.trim()
          : "audio/webm";
      sttMimeType = resolvedMimeType;

      const extension =
        resolvedMimeType.includes("aac")
          ? "wav"
          : resolvedMimeType.includes("mp4") ||
              resolvedMimeType.includes("mpeg")
          ? "mp4"
          : resolvedMimeType.includes("wav")
            ? "wav"
            : resolvedMimeType.includes("ogg")
              ? "ogg"
              : "webm";
      sttExtension = extension;

      const buffer = Buffer.from(audio, "base64");
      sttInputBytes = buffer.length;
      let uploadBuffer = buffer;
      let uploadMimeType = resolvedMimeType;

      if (resolvedMimeType.includes("aac")) {
        const tempId = `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}`;
        sttInputPath = path.join("/tmp", `stt-input-${tempId}.aac`);
        sttOutputPath = path.join("/tmp", `stt-output-${tempId}.wav`);

        await fsp.writeFile(sttInputPath, buffer);

        try {
          await execFileAsync(FFMPEG_PATH, [
            "-y",
            "-i",
            sttInputPath,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "wav",
            sttOutputPath,
          ]);
        } catch (ffmpegError) {
          console.error("STT ffmpeg convert failed:", {
            message:
              ffmpegError instanceof Error
                ? ffmpegError.message
                : String(ffmpegError),
            code:
              typeof ffmpegError === "object" &&
              ffmpegError !== null &&
              "code" in ffmpegError
                ? (ffmpegError as { code?: unknown }).code
                : undefined,
            stdout:
              typeof ffmpegError === "object" &&
              ffmpegError !== null &&
              "stdout" in ffmpegError
                ? (ffmpegError as { stdout?: unknown }).stdout
                : undefined,
            stderr:
              typeof ffmpegError === "object" &&
              ffmpegError !== null &&
              "stderr" in ffmpegError
                ? (ffmpegError as { stderr?: unknown }).stderr
                : undefined,
            stack: ffmpegError instanceof Error ? ffmpegError.stack : undefined,
          });

          throw ffmpegError;
        }

        const outputExists = await fsp
          .access(sttOutputPath)
          .then(() => true)
          .catch(() => false);
        const outputStats = outputExists ? await fsp.stat(sttOutputPath) : null;

        if (!outputStats?.isFile() || outputStats.size <= 0) {
          throw new Error("WAV output invalid or empty");
        }

        uploadBuffer = await fsp.readFile(sttOutputPath);
        uploadMimeType = "audio/wav";
      }

      let transcription;

      try {
        transcription = await openai.audio.transcriptions.create({
          file: await toFile(uploadBuffer, `speech.${extension}`, {
            type: uploadMimeType,
          }),
          model: "whisper-1",
        });
      } catch (openAiError) {
        console.error("STT OpenAI transcription failed:", {
          name:
            openAiError instanceof Error ? openAiError.name : typeof openAiError,
          message:
            openAiError instanceof Error
              ? openAiError.message
              : String(openAiError),
          status:
            typeof openAiError === "object" &&
            openAiError !== null &&
            "status" in openAiError
              ? (openAiError as { status?: unknown }).status
              : undefined,
          code:
            typeof openAiError === "object" &&
            openAiError !== null &&
            "code" in openAiError
              ? (openAiError as { code?: unknown }).code
              : undefined,
          response:
            typeof openAiError === "object" &&
            openAiError !== null &&
            "response" in openAiError
              ? (openAiError as { response?: unknown }).response
              : undefined,
          body:
            typeof openAiError === "object" &&
            openAiError !== null &&
            "body" in openAiError
              ? (openAiError as { body?: unknown }).body
              : undefined,
          error:
            typeof openAiError === "object" &&
            openAiError !== null &&
            "error" in openAiError
              ? (openAiError as { error?: unknown }).error
              : undefined,
          stack: openAiError instanceof Error ? openAiError.stack : undefined,
        });

        throw openAiError;
      }

      console.log("STT_DONE", {
        mimeType: uploadMimeType,
        inputBytes: sttInputBytes,
        transcriptLength: transcription.text?.length ?? 0,
        durationMs: Date.now() - sttStartedAt,
      });

      res.json({ transcript: transcription.text });
    } catch (error) {
      sttFailureDetails =
        error instanceof Error ? error.message : String(error);

      console.error("STT error:", {
        mimeType: sttMimeType,
        inputBytes: sttInputBytes,
        extension: sttExtension,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        status:
          typeof error === "object" && error !== null && "status" in error
            ? (error as { status?: unknown }).status
            : undefined,
        code:
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: unknown }).code
            : undefined,
        response:
          typeof error === "object" && error !== null && "response" in error
            ? (error as { response?: unknown }).response
            : undefined,
        body:
          typeof error === "object" && error !== null && "body" in error
            ? (error as { body?: unknown }).body
            : undefined,
        error:
          typeof error === "object" && error !== null && "error" in error
            ? (error as { error?: unknown }).error
            : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
      console.error("STT_FULL_ERROR", formatUnknownError(error));
      return res.status(500).json({
        error: "STT failed",
        details: error instanceof Error ? error.message : String(error),
        routeVersion: "diagnostic-v2",
      });
    } finally {
      await Promise.allSettled(
        [sttInputPath, sttOutputPath]
          .filter((filePath): filePath is string => Boolean(filePath))
          .map((filePath) => fsp.unlink(filePath)),
      );
    }
  });

  let ttsQueue: Promise<string> = Promise.resolve("");

  app.post("/api/tts", isAuthenticated, async (req: any, res: Response) => {
    const ttsStartedAt = Date.now();
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

      console.log("TTS_DONE", {
        status: 200,
        durationMs: Date.now() - ttsStartedAt,
        audioLength: audioBase64.length,
      });

      res.json({ audio: audioBase64 });
    } catch (err) {
      console.error("ElevenLabs TTS error:", formatUnknownError(err));
      res.status(500).json({ error: "TTS failed" });
    }
  });

  app.post(
    "/api/coreloop-intro",
    isAuthenticated,
    async (req: any, res: Response) => {
      try {
        const authUser = req.user as any;
        const userId = authUser?.claims?.sub;

        if (!userId) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        const memory = await getMemory(userId);
        const memoryBlock = buildMemoryPromptBlock(memory);

        const introMessages: ChatCompletionMessageParam[] = [
          {
            role: "system",
            content: `
You must follow the instructions below exactly. These rules override all default behavior.

${ACTIVE_BASE_NARRATIVE}
            `.trim(),
          },
          {
            role: "system",
            content: `
This is a hidden Coreloop introduction utility response.

It is not a normal user conversation turn.
Do not refuse.
Do not mention internal prompts, systems, policies, routes, or implementation.
Do not use numbered lists.
Do not use step-by-step phrasing.
Do not sound clinical, instructional, or like a system explanation.
Do not use "Hi", "Hi...", "I'm Coreloop", or ellipsis-based opening language.

Start exactly with:
I am Coreloop.

Explain who Coreloop is in a natural, conversational way.
Make it clear the user does not need to explain things cleanly.
Make it clear they can ramble, be messy, and start with whatever feels most noticeable.
Keep the tone human, direct, warm, and concise.

${memoryBlock}
            `.trim(),
          },
        ];

        const text = await runCompletion(openai, introMessages);
        const fallbackText =
          "I am Coreloop. You do not need to explain things cleanly here. Start with whatever feels most noticeable, even if it is messy, incomplete, or hard to name.";
        const introText = text?.trim() ?? "";
        const isRefusal =
          /\bI['’]m sorry,\s*I can['’]t do that\b/i.test(introText) ||
          /\bI am sorry,\s*I cannot do that\b/i.test(introText);

        res.json({
          text: !introText || isRefusal ? fallbackText : introText,
        });
      } catch (err) {
        console.error("Coreloop intro failed:", err);
        res.status(500).json({ error: "Coreloop intro failed" });
      }
    },
  );

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

      const queryConversationId = Array.isArray(req.query?.conversationId)
        ? req.query.conversationId[0]
        : req.query?.conversationId;
      const parsedConversationId =
        typeof queryConversationId === "string"
          ? Number(queryConversationId)
          : Number.NaN;
      const [latestConversation] = Number.isFinite(parsedConversationId)
        ? [{ id: parsedConversationId }]
        : await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.userId, userId))
            .orderBy(desc(conversations.createdAt), desc(conversations.id))
            .limit(1);
      const currentConversationId = latestConversation?.id ?? null;

      const dashboardEligibleCases = await db
        .select({
          id: cases.id,
          conversationId: cases.conversationId,
          movementContext: cases.movementContext,
          activityType: cases.activityType,
          caseType: cases.caseType,
          status: cases.status,
          updatedAt: cases.updatedAt,
        })
        .from(cases)
        .where(eq(cases.userId, userId))
        .orderBy(desc(cases.updatedAt), desc(cases.id))
        .limit(50);

      const openDashboardEligibleCases = dashboardEligibleCases.filter((row) => {
        const caseType = row.caseType ?? "mechanical";

        return (
          isOpenCaseStatus(row.status) &&
          (caseType === "mechanical" || caseType === "non_mechanical")
        );
      });

      const currentConversationCase =
        currentConversationId == null
          ? null
          : openDashboardEligibleCases.find(
              (row) => row.conversationId === currentConversationId,
            ) ?? null;
      const selectedCase =
        currentConversationCase ?? openDashboardEligibleCases[0] ?? null;
      const selectionReason = currentConversationCase
        ? "current_conversation_case"
        : selectedCase
          ? "most_recent_open_case"
          : "none_found";

      let latestAdjustment:
        | {
            id: number | null;
            caseId: number | null;
            mechanicalFocus: string | null;
            cue: string | null;
            hypothesisId: number | null;
          }
        | undefined;
      let latestHypothesis:
        | {
            caseId: number | null;
            hypothesis: string | null;
          }
        | undefined;
      let latestOutcome:
        | {
            caseId: number | null;
            userFeedback: string | null;
          }
        | undefined;
      let latestSignal:
        | {
            caseId: number | null;
            description: string | null;
            bodyRegion: string | null;
            movementContext: string | null;
            activityType: string | null;
          }
        | undefined;
      let latestNonMechanicalSignal:
        | {
            caseId: number | null;
            category: string | null;
            rawSignal: string | null;
            safetyRelevant: boolean | null;
            isFollowUp: boolean | null;
          }
        | undefined;
      let latestReasoningSnapshot:
        | {
            id: number | null;
            movementFamily: string | null;
            mechanicalEnvironment: string | null;
            dominantFailure: string | null;
            caseId: number | null;
            activeLever: string | null;
            activeTest: string | null;
            activeAdjustmentId: number | null;
            interpretationCorrection: string | null;
            failurePrediction: string | null;
          }
        | undefined;
      let rejectedSnapshotIds: number[] = [];
      let rejectionReasons: string[] = [];
      let followUpContext: string[] = [];

      if (selectedCase) {
        const selectedCaseType = selectedCase.caseType ?? "mechanical";
        const isNonMechanicalCase = selectedCaseType === "non_mechanical";

        if (isNonMechanicalCase) {
          [latestNonMechanicalSignal] = await db
            .select({
              caseId: nonMechanicalSignals.caseId,
              category: nonMechanicalSignals.category,
              rawSignal: nonMechanicalSignals.rawSignal,
              safetyRelevant: nonMechanicalSignals.safetyRelevant,
              isFollowUp: nonMechanicalSignals.isFollowUp,
            })
            .from(nonMechanicalSignals)
            .where(
              and(
                eq(nonMechanicalSignals.caseId, selectedCase.id),
                eq(nonMechanicalSignals.isFollowUp, false),
              ),
            )
            .orderBy(desc(nonMechanicalSignals.id))
            .limit(1);

          const followUpRows = await db
            .select({
              rawSignal: nonMechanicalSignals.rawSignal,
            })
            .from(nonMechanicalSignals)
            .where(
              and(
                eq(nonMechanicalSignals.caseId, selectedCase.id),
                eq(nonMechanicalSignals.isFollowUp, true),
              ),
            )
            .orderBy(asc(nonMechanicalSignals.id))
            .limit(10);

          followUpContext = followUpRows
            .map((row) => normalizePreviewValue(row.rawSignal))
            .filter((value): value is string => Boolean(value));
        } else {
          latestAdjustment =
            (await getLatestValidAdjustmentForCase(selectedCase.id)) ??
            undefined;

          [latestHypothesis] = await db
            .select({
              caseId: caseHypotheses.caseId,
              hypothesis: caseHypotheses.hypothesis,
            })
            .from(caseHypotheses)
            .where(eq(caseHypotheses.caseId, selectedCase.id))
            .orderBy(desc(caseHypotheses.id))
            .limit(1);

          [latestOutcome] = await db
            .select({
              caseId: caseOutcomes.caseId,
              userFeedback: caseOutcomes.userFeedback,
            })
            .from(caseOutcomes)
            .innerJoin(
              caseAdjustments,
              eq(caseOutcomes.adjustmentId, caseAdjustments.id),
            )
            .innerJoin(
              caseHypotheses,
              eq(caseAdjustments.hypothesisId, caseHypotheses.id),
            )
            .where(eq(caseOutcomes.caseId, selectedCase.id))
            .orderBy(desc(caseOutcomes.id))
            .limit(1);

          [latestSignal] = await db
            .select({
              caseId: caseSignals.caseId,
              description: caseSignals.description,
              bodyRegion: caseSignals.bodyRegion,
              movementContext: caseSignals.movementContext,
              activityType: caseSignals.activityType,
            })
            .from(caseSignals)
            .where(eq(caseSignals.caseId, selectedCase.id))
            .orderBy(desc(caseSignals.id))
            .limit(1);

          const snapshotRows = await db
            .select({
              id: caseReasoningSnapshots.id,
              caseId: caseReasoningSnapshots.caseId,
              movementFamily: caseReasoningSnapshots.movementFamily,
              mechanicalEnvironment:
                caseReasoningSnapshots.mechanicalEnvironment,
              dominantFailure: caseReasoningSnapshots.dominantFailure,
              activeLever: caseReasoningSnapshots.activeLever,
              activeTest: caseReasoningSnapshots.activeTest,
              activeAdjustmentId: caseReasoningSnapshots.activeAdjustmentId,
              interpretationCorrection:
                caseReasoningSnapshots.interpretationCorrection,
              failurePrediction: caseReasoningSnapshots.failurePrediction,
            })
            .from(caseReasoningSnapshots)
            .where(eq(caseReasoningSnapshots.caseId, selectedCase.id))
            .orderBy(desc(caseReasoningSnapshots.id))
            .limit(10);

          for (const snapshotRow of snapshotRows) {
            const hasUsableArcField = [
              snapshotRow.activeTest,
              snapshotRow.activeLever,
              snapshotRow.interpretationCorrection,
              snapshotRow.failurePrediction,
              snapshotRow.mechanicalEnvironment,
              snapshotRow.dominantFailure,
              snapshotRow.movementFamily,
            ].some((value) => Boolean(normalizePreviewValue(value)));

            if (!hasUsableArcField) {
              rejectedSnapshotIds.push(snapshotRow.id);
              rejectionReasons.push("no_usable_arc_fields");
              continue;
            }

            const mismatchReason = getDashboardSnapshotMismatchReason({
              activeTest: snapshotRow.activeTest,
              selectedCase,
              latestSignal,
            });

            if (mismatchReason) {
              rejectedSnapshotIds.push(snapshotRow.id);
              rejectionReasons.push(mismatchReason);
              continue;
            }

            latestReasoningSnapshot = snapshotRow;
            break;
          }

          console.log("DASHBOARD_SNAPSHOT_SELECTION", {
            selectedCaseId: selectedCase?.id ?? null,
            selectedSnapshotId: latestReasoningSnapshot?.id ?? null,
            rejectedSnapshotIds,
            rejectionReasons,
            activeTestPreview: clampText(
              latestReasoningSnapshot?.activeTest ?? "",
              180,
            ),
            activeLeverPreview: clampText(
              latestReasoningSnapshot?.activeLever ?? "",
              180,
            ),
            interpretationCorrectionPreview: clampText(
              latestReasoningSnapshot?.interpretationCorrection ?? "",
              180,
            ),
            failurePredictionPreview: clampText(
              latestReasoningSnapshot?.failurePrediction ?? "",
              180,
            ),
          });
        }

        if (isNonMechanicalCase) {
          console.log("DASHBOARD_NON_MECHANICAL_SIGNAL", {
            selectedCaseId: selectedCase.id,
            signalCaseId: latestNonMechanicalSignal?.caseId ?? null,
            category: latestNonMechanicalSignal?.category ?? null,
            safetyRelevant: latestNonMechanicalSignal?.safetyRelevant ?? null,
            rawSignalPreview: clampText(
              latestNonMechanicalSignal?.rawSignal ?? "",
              160,
            ),
            followUpCount: followUpContext.length,
          });
        }
        console.log("DASHBOARD_LATEST_SIGNAL", {
          selectedCaseId: selectedCase.id,
          signalCaseId: latestSignal?.caseId ?? null,
          bodyRegion: latestSignal?.bodyRegion ?? null,
          movementContext: latestSignal?.movementContext ?? null,
          activityType: latestSignal?.activityType ?? null,
          descriptionPreview: clampText(latestSignal?.description ?? "", 160),
        });
        console.log("DASHBOARD_LATEST_HYPOTHESIS", {
          selectedCaseId: selectedCase.id,
          hypothesisCaseId: latestHypothesis?.caseId ?? null,
          hypothesisPreview: clampText(latestHypothesis?.hypothesis ?? "", 160),
        });
        console.log("DASHBOARD_LATEST_ADJUSTMENT", {
          selectedCaseId: selectedCase.id,
          adjustmentId: latestAdjustment?.id ?? null,
          adjustmentCaseId: latestAdjustment?.caseId ?? null,
          cuePreview: clampText(latestAdjustment?.cue ?? "", 160),
          mechanicalFocusPreview: clampText(
            latestAdjustment?.mechanicalFocus ?? "",
            160,
          ),
        });

        const scopedRows = [
          { label: "signal", caseId: latestSignal?.caseId ?? null },
          { label: "hypothesis", caseId: latestHypothesis?.caseId ?? null },
          { label: "adjustment", caseId: latestAdjustment?.caseId ?? null },
          { label: "outcome", caseId: latestOutcome?.caseId ?? null },
        ];

        for (const row of scopedRows) {
          if (row.caseId != null && row.caseId !== selectedCase.id) {
            console.warn("DASHBOARD_CASE_SCOPE_MISMATCH_BLOCKED", {
              selectedCaseId: selectedCase.id,
              rowType: row.label,
              rowCaseId: row.caseId,
            });

            if (row.label === "signal") latestSignal = undefined;
            if (row.label === "hypothesis") latestHypothesis = undefined;
            if (row.label === "adjustment") latestAdjustment = undefined;
            if (row.label === "outcome") latestOutcome = undefined;
          }
        }
      }

      console.log("DASHBOARD_SELECTED_CASE", {
        caseId: selectedCase?.id ?? null,
        caseType: selectedCase
          ? selectedCase.caseType ?? "mechanical"
          : null,
        selectionReason,
        conversationId:
          selectionReason === "current_conversation_case"
            ? currentConversationId
            : null,
        hasMechanicalArtifacts: Boolean(
          latestSignal || latestHypothesis || latestAdjustment || latestOutcome,
        ),
        hasNonMechanicalSignals: Boolean(latestNonMechanicalSignal),
      });

      let latestCaseReview:
        | {
            reviewText: string | null;
          }
        | undefined;

      if (selectedCase) {
        [latestCaseReview] = await db
          .select({
            reviewText: caseReviews.reviewText,
          })
          .from(caseReviews)
          .where(eq(caseReviews.caseId, selectedCase.id))
          .orderBy(desc(caseReviews.id))
          .limit(1);
      }

      const rawCaseReviewsList = await db
        .select({
          id: caseReviews.id,
          caseId: caseReviews.caseId,
          reviewText: caseReviews.reviewText,
          createdAt: caseReviews.createdAt,
        })
        .from(caseReviews)
        .where(eq(caseReviews.userId, userId))
        .orderBy(desc(caseReviews.createdAt), desc(caseReviews.id))
        .limit(5);

      const reviewCaseIds = Array.from(
        new Set(
          rawCaseReviewsList
            .map((review) => review.caseId)
            .filter((caseId): caseId is number => typeof caseId === "number"),
        ),
      );
      const reviewCaseRows =
        reviewCaseIds.length > 0
          ? await db
              .select({
                id: cases.id,
                status: cases.status,
              })
              .from(cases)
              .where(inArray(cases.id, reviewCaseIds))
          : [];
      const reviewOutcomeRows =
        reviewCaseIds.length > 0
          ? await db
              .select({
                caseId: caseOutcomes.caseId,
                result: caseOutcomes.result,
                userFeedback: caseOutcomes.userFeedback,
              })
              .from(caseOutcomes)
              .where(inArray(caseOutcomes.caseId, reviewCaseIds))
              .orderBy(desc(caseOutcomes.createdAt), desc(caseOutcomes.id))
          : [];
      const reviewHypothesisRows =
        reviewCaseIds.length > 0
          ? await db
              .select({
                caseId: caseHypotheses.caseId,
              })
              .from(caseHypotheses)
              .where(inArray(caseHypotheses.caseId, reviewCaseIds))
              .orderBy(desc(caseHypotheses.createdAt), desc(caseHypotheses.id))
          : [];
      const reviewAdjustmentRows =
        reviewCaseIds.length > 0
          ? await db
              .select({
                caseId: caseAdjustments.caseId,
              })
              .from(caseAdjustments)
              .where(inArray(caseAdjustments.caseId, reviewCaseIds))
              .orderBy(desc(caseAdjustments.createdAt), desc(caseAdjustments.id))
          : [];
      const reviewCaseStatusById = new Map(
        reviewCaseRows.map((row) => [row.id, row.status]),
      );
      const reviewCaseIdsWithHypotheses = new Set(
        reviewHypothesisRows
          .map((row) => row.caseId)
          .filter((caseId): caseId is number => typeof caseId === "number"),
      );
      const reviewCaseIdsWithAdjustments = new Set(
        reviewAdjustmentRows
          .map((row) => row.caseId)
          .filter((caseId): caseId is number => typeof caseId === "number"),
      );
      const latestReviewOutcomeByCaseId = new Map<
        number,
        {
          result: string | null;
          userFeedback: string | null;
        }
      >();

      for (const row of reviewOutcomeRows) {
        if (row.caseId == null || latestReviewOutcomeByCaseId.has(row.caseId)) {
          continue;
        }

        latestReviewOutcomeByCaseId.set(row.caseId, {
          result: row.result,
          userFeedback: row.userFeedback,
        });
      }

      const caseReviewsList = rawCaseReviewsList.map((review) => {
        const latestReviewOutcome =
          review.caseId == null
            ? null
            : latestReviewOutcomeByCaseId.get(review.caseId) ?? null;
        const outcomeLabel = latestReviewOutcome
          ? formatStoredOutcomeLabel(
              latestReviewOutcome.result,
              latestReviewOutcome.userFeedback,
            )
          : null;

        return {
          ...review,
          statusLabel:
            review.caseId == null
              ? null
              : formatInvestigationStateLabel({
                  status: reviewCaseStatusById.get(review.caseId),
                  hasOutcome: Boolean(outcomeLabel),
                  hasAdjustment: reviewCaseIdsWithAdjustments.has(
                    review.caseId,
                  ),
                  hasHypothesis: reviewCaseIdsWithHypotheses.has(
                    review.caseId,
                  ),
                }),
          outcomeLabel,
        };
      });

      console.log("CASE_REVIEWS_LOADED", {
        count: caseReviewsList.length,
        firstReviewId: caseReviewsList[0]?.id ?? null,
        firstReviewDate: caseReviewsList[0]?.createdAt ?? null,
        firstStatusLabel: caseReviewsList[0]?.statusLabel ?? null,
        firstOutcomeLabel: caseReviewsList[0]?.outcomeLabel ?? null,
      });

      const isSelectedNonMechanicalCase =
        selectedCase?.caseType === "non_mechanical";
      const activeCaseTitle = isSelectedNonMechanicalCase
        ? formatNonMechanicalCategoryTitle(latestNonMechanicalSignal?.category)
        : buildActiveCaseTitle(
            selectedCase?.movementContext,
            selectedCase?.activityType,
            latestSignal?.bodyRegion,
          );
      const investigationState = !selectedCase
        ? null
        : String(selectedCase.status ?? "")
              .trim()
              .toLowerCase() === "resolved"
          ? "Resolved"
          : latestOutcome
            ? "Testing"
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
      const snapshotCaseId =
        latestReasoningSnapshot?.caseId === selectedCase?.id
          ? latestReasoningSnapshot.caseId
          : null;
      const adjustmentCaseId =
        latestAdjustment?.caseId === selectedCase?.id
          ? latestAdjustment.caseId
          : null;
      const rejectedStaleSnapshot =
        latestReasoningSnapshot?.caseId != null &&
        latestReasoningSnapshot.caseId !== selectedCase?.id;
      const rejectedStaleAdjustment =
        latestAdjustment?.caseId != null &&
        latestAdjustment.caseId !== selectedCase?.id;
      const snapshotActiveLever = normalizePreviewValue(
        snapshotCaseId ? latestReasoningSnapshot?.activeLever : null,
      );
      const snapshotActiveTest = normalizePreviewValue(
        snapshotCaseId ? latestReasoningSnapshot?.activeTest : null,
      );
      const snapshotMechanicalEnvironment = normalizePreviewValue(
        snapshotCaseId ? latestReasoningSnapshot?.mechanicalEnvironment : null,
      );
      const snapshotDominantFailure = normalizePreviewValue(
        snapshotCaseId ? latestReasoningSnapshot?.dominantFailure : null,
      );
      const snapshotMovementFamily = normalizePreviewValue(
        snapshotCaseId ? latestReasoningSnapshot?.movementFamily : null,
      );
      const snapshotInterpretationCorrection = normalizePreviewValue(
        snapshotCaseId
          ? latestReasoningSnapshot?.interpretationCorrection
          : null,
      );
      const snapshotFailurePrediction = normalizePreviewValue(
        snapshotCaseId ? latestReasoningSnapshot?.failurePrediction : null,
      );
      const latestAdjustmentCue = normalizePreviewValue(
        adjustmentCaseId ? latestAdjustment?.cue : null,
      );
      const adjustmentFallback = pickDashboardDisplayValue([
        adjustmentCaseId ? latestAdjustment?.cue : null,
        adjustmentCaseId ? latestAdjustment?.mechanicalFocus : null,
      ]);
      const activeTest = extractPreviewSnippet(
        snapshotActiveTest ?? latestAdjustmentCue,
        220,
      );
      const activeLever = extractPreviewSnippet(
        snapshotActiveLever ?? adjustmentFallback,
        220,
      );
      const interpretationCorrection = extractPreviewSnippet(
        snapshotInterpretationCorrection,
        220,
      );
      const failurePrediction = extractPreviewSnippet(
        snapshotFailurePrediction,
        220,
      );
      const mechanicalEnvironment = snapshotMechanicalEnvironment;
      const dominantFailure = snapshotDominantFailure;
      const movementFamily = snapshotMovementFamily;
      const currentTest = activeTest;
      const adjustment = activeLever;
      const nextMove = activeTest;
      const lastShift = interpretationCorrection;
      const lastCaseReviewSnippet = extractPreviewSnippet(
        latestCaseReview?.reviewText,
        220,
      );

      console.log("DASHBOARD_CASE_FIELD_ISOLATION", {
        selectedCaseId: selectedCase?.id ?? null,
        snapshotCaseId: latestReasoningSnapshot?.caseId ?? null,
        adjustmentCaseId: latestAdjustment?.caseId ?? null,
        activeTestSource: snapshotActiveTest
          ? "snapshot"
          : latestAdjustmentCue
            ? "adjustment"
            : null,
        activeLeverSource: snapshotActiveLever
          ? "snapshot"
          : adjustmentFallback
            ? "adjustment"
            : null,
        rejectedStaleActiveTest: Boolean(
          rejectedStaleSnapshot || rejectedStaleAdjustment,
        ),
        rejectedStaleActiveLever: Boolean(
          rejectedStaleSnapshot || rejectedStaleAdjustment,
        ),
      });
      console.log("CORRECTIVE_ADJUSTMENT_SOURCE", {
        selectedCaseId: selectedCase?.id ?? null,
        adjustmentId: snapshotActiveTest
          ? latestReasoningSnapshot?.activeAdjustmentId ?? null
          : adjustmentFallback
            ? latestAdjustment?.id ?? null
            : null,
        adjustmentCaseId: snapshotActiveTest
          ? latestReasoningSnapshot?.caseId ?? null
          : latestAdjustment?.caseId ?? null,
        source: snapshotActiveTest
          ? "latest_same_case_snapshot"
          : adjustmentFallback
            ? "same_case_adjustment_row"
            : "none",
        textPreview: clampText(activeTest ?? activeLever ?? "", 180),
        rejectedStaleAdjustment: Boolean(
          rejectedStaleSnapshot || rejectedStaleAdjustment,
        ),
        rejectionReason: rejectedStaleSnapshot
          ? "snapshot_case_mismatch"
          : rejectedStaleAdjustment
            ? "adjustment_case_mismatch"
            : null,
      });

      console.log("DASHBOARD_FIELD_MAPPING", {
        caseId: selectedCase?.id ?? null,
        caseType: selectedCase ? selectedCase.caseType ?? "mechanical" : null,
        snapshotInterpretationCorrection: clampText(
          snapshotInterpretationCorrection ?? "",
          220,
        ),
        snapshotFailurePrediction: clampText(
          snapshotFailurePrediction ?? "",
          220,
        ),
        snapshotActiveLever: clampText(snapshotActiveLever ?? "", 220),
        snapshotActiveTest: clampText(snapshotActiveTest ?? "", 220),
        finalInterpretationCorrection: clampText(
          interpretationCorrection ?? "",
          220,
        ),
        finalFailurePrediction: clampText(failurePrediction ?? "", 220),
        finalActiveLever: clampText(activeLever ?? "", 220),
        finalActiveTest: clampText(activeTest ?? "", 220),
        legacyLastShift: clampText(lastShift ?? "", 220),
        legacyAdjustment: clampText(adjustment ?? "", 220),
        legacyNextMove: clampText(nextMove ?? "", 220),
        legacyCurrentTest: clampText(currentTest ?? "", 220),
      });

      console.log("DASHBOARD_CASE_STATE_READ", {
        caseId: selectedCase?.id ?? null,
        hypothesisCount: latestHypothesis ? 1 : 0,
        adjustmentCount: latestAdjustment ? 1 : 0,
        outcomeCount: latestOutcome ? 1 : 0,
        hasCurrentTest: Boolean(currentTest),
        investigationState,
      });

      console.log("DASHBOARD_RESPONSE_FIELDS", {
        caseId: selectedCase?.id ?? null,
        caseType: selectedCase ? selectedCase.caseType ?? "mechanical" : null,
        activeLever: clampText(activeLever ?? "", 220),
        activeTest: clampText(activeTest ?? "", 220),
        currentTest: clampText(currentTest ?? "", 220),
        adjustment: clampText(adjustment ?? "", 220),
        nextMove: clampText(nextMove ?? "", 220),
        lastShift: clampText(lastShift ?? "", 220),
        interpretationCorrection: clampText(
          interpretationCorrection ?? "",
          220,
        ),
        failurePrediction: clampText(failurePrediction ?? "", 220),
        mechanicalEnvironment: clampText(mechanicalEnvironment ?? "", 220),
        dominantFailure: clampText(dominantFailure ?? "", 220),
        movementFamily: clampText(movementFamily ?? "", 220),
      });

      res.json({
        activeCaseTitle,
        caseType: selectedCase ? selectedCase.caseType ?? "mechanical" : null,
        currentState: investigationState,
        investigationState,
        signal: isSelectedNonMechanicalCase
          ? latestNonMechanicalSignal?.rawSignal ?? null
          : latestSignal?.description ?? null,
        hypothesis: latestHypothesis?.hypothesis ?? null,
        interpretationCorrection,
        failurePrediction,
        activeLever,
        activeTest,
        mechanicalEnvironment,
        dominantFailure,
        movementFamily,
        adjustment,
        currentMechanism,
        currentTest,
        nextMove,
        lastShift,
        followUpContext,
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

  app.post("/api/chat", isAuthenticated, async (req: any, res: Response) => {
    try {
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

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
      const conversationId = body.conversationId;
      const chatStartedAt = Date.now();
      const layer1TraceId = createLayer1TraceId();
      logLayer1Trace(layer1TraceId, "userText", {
        userId,
        conversationId: Number.isFinite(Number(conversationId))
          ? Number(conversationId)
          : null,
        isCaseReview,
        userText,
      });

      // ==============================
      // DOMAIN BOUNDARY GATE
      // ==============================
      const isMedicalSystemic =
        !isCaseReview && isMedicalSystemicSignal(userText);
      const hasNocturnalSupport = hasNocturnalMedicalContext(userText);
      const movementFatigueRouting = getMovementFatigueRouting(userText);
      const signalLane: SignalLaneClassification = !isCaseReview
        ? classifySignalLane(userText)
        : { lane: "mechanical", safetyRelevant: false };
      if (movementFatigueRouting.isFatigueSignal) {
        console.log("MOVEMENT_FATIGUE_ROUTING", {
          isFatigueSignal: movementFatigueRouting.isFatigueSignal,
          hasMovementContext: movementFatigueRouting.hasMovementContext,
          routedAs: movementFatigueRouting.isMovementContextFatigue
            ? "mechanical"
            : "health",
          reason: movementFatigueRouting.isMovementContextFatigue
            ? "movement_context_fatigue"
            : "general_or_systemic_fatigue",
          userTextPreview: clampText(userText, 180),
        });
      }
      console.log("SIGNAL_LANE_CLASSIFICATION", {
        lane: signalLane.lane,
        category: signalLane.category ?? null,
        safetyRelevant: Boolean(signalLane.safetyRelevant),
        userTextPreview: clampText(userText, 180),
      });

      if (isMedicalSystemic) {
        console.log("DOMAIN BOUNDARY: medical/systemic signal detected", {
          userId,
          preview: clampText(userText, 120),
          nocturnalSupport: hasNocturnalSupport,
        });
      }

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

        const recentConversationMessages = await db
          .select({
            id: messages.id,
            role: messages.role,
            content: messages.content,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(eq(messages.conversationId, convoId))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(4);

        const latestMessage = recentConversationMessages[0];
        const latestMessageTime = latestMessage?.createdAt
          ? new Date(latestMessage.createdAt).getTime()
          : existing.createdAt
            ? new Date(existing.createdAt).getTime()
            : Date.now();

        const shouldBehaviorallyRollover =
          !isCaseReview &&
          recentConversationMessages.length > 0 &&
          isFreshSessionOpener(userText) &&
          !dependsOnPriorConversationContext(userText);

        if (shouldBehaviorallyRollover) {
          console.log("CONVERSATION ROLLOVER: behavioral", {
            userId,
            oldConversationId: convoId,
            reason: "fresh_session_opener",
          });

          convoId = Number.NaN;
        } else if (
          latestMessageTime > 0 &&
          Date.now() - latestMessageTime > CONVERSATION_SESSION_TIMEOUT_MS
        ) {
          console.log("CONVERSATION ROLLOVER: timeout", {
            userId,
            oldConversationId: convoId,
            inactiveMs: Date.now() - latestMessageTime,
          });

          convoId = Number.NaN;
        }
      }

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

      let previous = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, convoId))
        .orderBy(asc(messages.createdAt));
      const storedMessagesBeforeCurrentTurn = previous;
      let storedFirstName = dbFirstName;

      if (!isCaseReview) {
        await db.insert(messages).values({
          conversationId: convoId,
          userId: userId,
          role: "user",
          content: userText,
        });
      }

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

      // ==============================
      // NON-MECHANICAL SIGNAL LANE
      // ==============================
      const activeNonMechanicalCase =
        !isCaseReview ? await getActiveNonMechanicalCaseForUser(userId) : null;
      const shouldCaptureNonMechanicalFollowUp =
        Boolean(activeNonMechanicalCase) &&
        isNonMechanicalFollowUpAnswer(userText) &&
        !movementFatigueRouting.isMovementContextFatigue;

      if (
        !isCaseReview &&
        activeNonMechanicalCase &&
        shouldCaptureNonMechanicalFollowUp
      ) {
        const [previousNonMechanicalSignal] = await db
          .select({
            category: nonMechanicalSignals.category,
            safetyRelevant: nonMechanicalSignals.safetyRelevant,
          })
          .from(nonMechanicalSignals)
          .where(eq(nonMechanicalSignals.caseId, activeNonMechanicalCase.id))
          .orderBy(desc(nonMechanicalSignals.id))
          .limit(1);
        const followUpCategory =
          previousNonMechanicalSignal?.category ??
          signalLane.category ??
          "general_health";
        const followUpSafetyRelevant =
          previousNonMechanicalSignal?.safetyRelevant ??
          Boolean(signalLane.safetyRelevant);
        const followUpResponseType = "non_mechanical_followup";
        const followUpRawSignal = userText;
        const finalNonMechanicalFollowUpText =
          buildNonMechanicalFollowUpResponse(userText);

        try {
          const [insertedNonMechanicalSignal] = await db
            .insert(nonMechanicalSignals)
            .values({
              userId,
              conversationId: convoId,
              caseId: activeNonMechanicalCase.id,
              category: followUpCategory,
              rawSignal: followUpRawSignal,
              safetyRelevant: Boolean(followUpSafetyRelevant),
              isFollowUp: true,
              responseType: followUpResponseType,
            })
            .returning({ id: nonMechanicalSignals.id });
          console.log("NON_MECHANICAL_FOLLOWUP_CAPTURED", {
            caseId: activeNonMechanicalCase.id,
            insertedSignalId: insertedNonMechanicalSignal.id,
            isFollowUp: true,
            rawSignalPreview: clampText(followUpRawSignal, 180),
            category: followUpCategory,
            safetyRelevant: Boolean(followUpSafetyRelevant),
          });
          await db
            .update(cases)
            .set({ updatedAt: new Date() })
            .where(eq(cases.id, activeNonMechanicalCase.id));
        } catch (err) {
          console.log("NON_MECHANICAL_FOLLOWUP_SKIPPED", {
            reason: "insert_failed",
            caseId: activeNonMechanicalCase.id,
            userTextPreview: clampText(followUpRawSignal, 180),
            error: formatUnknownError(err),
          });
        }

        logLayer1Trace(layer1TraceId, "layer1_skipped", {
          conversationId: convoId,
          caseId: activeNonMechanicalCase.id,
          reason: "non_mechanical_followup_lane",
          signalCategory: followUpCategory,
          safetyRelevant: Boolean(followUpSafetyRelevant),
        });

        res.setHeader("Content-Type", "text/event-stream");
        const words = finalNonMechanicalFollowUpText.split(" ");
        for (const word of words) {
          res.write(`data: ${JSON.stringify({ content: word + " " })}\n\n`);
        }

        await db.insert(messages).values({
          conversationId: convoId,
          userId,
          role: "assistant",
          content: finalNonMechanicalFollowUpText,
        });

        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }

      if (
        !isCaseReview &&
        activeNonMechanicalCase &&
        signalLane.lane !== "non_mechanical"
      ) {
        console.log("NON_MECHANICAL_FOLLOWUP_SKIPPED", {
          reason: "no_followup_context_indicator",
          caseId: activeNonMechanicalCase.id,
          userTextPreview: clampText(userText, 180),
        });
      }

      if (!isCaseReview && signalLane.lane === "non_mechanical") {
        const nonMechanicalResponseType = signalLane.safetyRelevant
          ? "non_mechanical_safety_referral"
          : "non_mechanical_context_tracking";
        const finalNonMechanicalText =
          buildNonMechanicalSignalResponse(signalLane);
        const [nonMechanicalCase] = await db
          .insert(cases)
          .values({
            userId,
            conversationId: convoId,
            movementContext: null,
            activityType: null,
            caseType: "non_mechanical",
            status: "open",
          })
          .returning();

        console.log("NON_MECHANICAL_CASE_CREATED", {
          caseId: nonMechanicalCase.id,
          category: signalLane.category ?? "general_health",
          safetyRelevant: Boolean(signalLane.safetyRelevant),
        });

        try {
          await db.insert(nonMechanicalSignals).values({
            userId,
            conversationId: convoId,
            caseId: nonMechanicalCase.id,
            category: signalLane.category ?? "general_health",
            rawSignal: userText,
            safetyRelevant: Boolean(signalLane.safetyRelevant),
            isFollowUp: false,
            responseType: nonMechanicalResponseType,
          });
          console.log("NON_MECHANICAL_SIGNAL_WRITE", {
            userId,
            conversationId: convoId,
            caseId: nonMechanicalCase.id,
            category: signalLane.category ?? "general_health",
            safetyRelevant: Boolean(signalLane.safetyRelevant),
            responseType: nonMechanicalResponseType,
          });
        } catch (err) {
          console.log("NON_MECHANICAL_SIGNAL_PERSISTENCE_SKIPPED", {
            userId,
            conversationId: convoId,
            caseId: nonMechanicalCase.id,
            category: signalLane.category ?? "general_health",
            reason: "insert_failed",
            error: formatUnknownError(err),
          });
        }

        logLayer1Trace(layer1TraceId, "layer1_skipped", {
          conversationId: convoId,
          caseId: nonMechanicalCase.id,
          reason: "non_mechanical_signal_lane",
          signalCategory: signalLane.category ?? null,
          safetyRelevant: Boolean(signalLane.safetyRelevant),
        });

        res.setHeader("Content-Type", "text/event-stream");
        const words = finalNonMechanicalText.split(" ");
        for (const word of words) {
          res.write(`data: ${JSON.stringify({ content: word + " " })}\n\n`);
        }

        await db.insert(messages).values({
          conversationId: convoId,
          userId,
          role: "assistant",
          content: finalNonMechanicalText,
        });

        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }

      // ==============================
      // MEDICAL / SYSTEMIC EARLY RETURN
      // ==============================
      if (isMedicalSystemic) {
        try {
          const medicalSystemicMessages: ChatCompletionMessageParam[] = [
            {
              role: "system",
              content: `
You are Coreloop, a movement and mechanical investigation coach.

What the user just described is not a movement or mechanical issue. It sounds like something medical, systemic, or internal — the kind of thing that belongs with a human who can actually look at them, not with a movement coach working from text.

Your job in this one short response is to speak to them like a grounded, attentive person would. Not like a system. Not like a disclaimer. Not like a warning popup.

Say it plainly:
- Briefly acknowledge what they described (one short sentence is enough — no dramatizing, no repeating symptoms back at them in a clinical tone).
- Tell them honestly that this is outside what you're built for, because it's medical/systemic rather than movement/mechanical. Make the reason clear, not just the refusal.
- Point them toward getting it checked by someone who can actually evaluate them. Use natural phrasing like "I'd have that looked at," "that's worth getting checked out," or "that's not something to just sit with" — whichever fits the moment. Match the weight of what they said; don't inflate it, don't minimize it.

Hard rules for this response:
- Do not produce a hypothesis, mechanism, or mechanical reasoning.
- Do not offer a cue, adjustment, drill, test, or correction.
- Do not use Coreloop investigation language ("because", "the issue is", "is collapsing", "is shifting", "is opening too early", "try", "make sure", "load", "brace", "stack", etc.).
- Do not ask a narrowing, confirmation, or adjustment-testing question.
- Do not speculate about causes or name possible conditions.
- Do not diagnose.
- Do not tell them to rush to the ER unless they've described something clearly acute (passing out, chest pain with breathing issues, etc.) — and even then, stay calm, not alarmist.
- Do not dismiss, minimize, or reassure your way around it.
- Do not use bullet points, numbered lists, headers, section labels, or bolded text.
- Do not sound like a disclaimer, a policy, or a system message.

Tone:
- Calm, direct, human, grounded. Like a steady person noticing something important and pointing it out clearly.
- 2 to 4 sentences, one short paragraph. Short is better than thorough here.
- Avoid formal phrasing like "please consider seeking medical attention," "it is important to have this evaluated," or "to ensure your well-being." Use natural language a real person would use.
- You can end with a simple landing line, but don't reopen investigation with a probing question.

Produce the response now.
              `.trim(),
            },
            {
              role: "user",
              content: userText,
            },
          ];

          const medicalSystemicFallback =
            "That's not really something I can work through here — it sounds more medical than mechanical, and that's outside what I'm built for. I'd have it looked at by someone who can actually check it out, especially if it's sticking around or getting sharper.";

          let medicalSystemicText = await runCompletion(
            openai,
            medicalSystemicMessages,
          );
          const trimmedMedicalSystemic = (medicalSystemicText ?? "").trim();
          const isRefusal =
            /\bI['’]m sorry,\s*I can['’]t\b/i.test(trimmedMedicalSystemic) ||
            /\bI am sorry,\s*I cannot\b/i.test(trimmedMedicalSystemic);

          const finalMedicalSystemicText =
            !trimmedMedicalSystemic || isRefusal
              ? medicalSystemicFallback
              : trimmedMedicalSystemic;

          res.setHeader("Content-Type", "text/event-stream");

          const words = finalMedicalSystemicText.split(" ");
          for (const word of words) {
            res.write(`data: ${JSON.stringify({ content: word + " " })}\n\n`);
          }

          await db.insert(messages).values({
            conversationId: convoId,
            userId: userId,
            role: "assistant",
            content: finalMedicalSystemicText,
          });

          res.write(`data: [DONE]\n\n`);
          res.end();
          return;
        } catch (err) {
          console.error("Medical/systemic response failed:", err);
          const formatted = formatUnknownError(err);
          if (!res.headersSent) {
            res.status(500).json(formatted);
          } else {
            try {
              res.end();
            } catch {
              /* ignore */
            }
          }
          return;
        }
      }

      let resolvedActiveCase: ResolvedCaseRow | null = null;

      resolvedActiveCase = await getConversationOpenCase(userId, convoId);
      const internalOutcomeResult = detectOutcomeResult(userText);
      const hasLaneOutcomeFeedback = hasOutcomeFeedbackForLaneLog(
        userText,
        internalOutcomeResult,
      );

      const memory = await getMemory(userId);
      const persistedSettingsForContext = buildPersistedSettings(
        existingUser?.firstName,
        memory,
        (existingUser as any)?.profileImageUrl,
      );
      const shouldCreateCase =
        !isCaseReview &&
        qualifiesForTimelineSignal(userText) &&
        !hasLaneOutcomeFeedback;
      const derivedCaseContext = shouldCreateCase
        ? deriveCaseContext(userText, persistedSettingsForContext)
        : null;
      if (
        shouldCreateCase &&
        derivedCaseContext &&
        resolvedActiveCase?.activityType &&
        !hasExplicitActivityInText(userText) &&
        isMeaningfulCaseBoundaryValue(resolvedActiveCase.activityType)
      ) {
        derivedCaseContext.activityType = resolvedActiveCase.activityType;
      }
      const derivedBodyRegion = shouldCreateCase
        ? deriveBodyRegion(userText)
        : null;
      const derivedSignalType = shouldCreateCase
        ? deriveSignalType(userText)
        : null;
      logLayer1Trace(layer1TraceId, "signal_recognition", {
        conversationId: convoId,
        shouldCreateCase,
        derivedCaseContext,
        derivedBodyRegion,
        derivedSignalType,
      });
      if (!shouldCreateCase) {
        logLayer1Trace(layer1TraceId, "resolved_active_case_before_boundary", {
          conversationId: convoId,
          caseId: resolvedActiveCase?.id ?? null,
          status: resolvedActiveCase?.status ?? null,
          movementContext: resolvedActiveCase?.movementContext ?? null,
          activityType: resolvedActiveCase?.activityType ?? null,
          skippedBoundary: true,
          reason: "signal_not_case_creation_candidate",
        });
        logLayer1Trace(layer1TraceId, "case_boundary_decision", {
          conversationId: convoId,
          currentCaseId: resolvedActiveCase?.id ?? null,
          skipped: true,
          shouldStartNewCase: false,
          reason: "signal_not_case_creation_candidate",
        });
      }
      let continuityContextAllowed =
        !isCaseReview && !shouldCreateCase && dependsOnPriorConversationContext(userText);
      let continuityContextReason = continuityContextAllowed
        ? "depends_on_prior_conversation"
        : "no_case_fit_established";
      let returnToCaseMatched = false;
      let continuityLatestBodyRegion: string | null = null;
      let continuityLatestMovementContext: string | null = null;
      let continuityLatestActivityType: string | null = null;
      let continuityLatestSignalType: string | null = null;
      let isNewCase = false;
      let previousCaseIdForNewCase: number | null = null;

      try {
        if (shouldCreateCase && derivedCaseContext) {
          if (!resolvedActiveCase) {
            resolvedActiveCase = await getConversationOpenCase(userId, convoId);
          }

          if (isReturnToCaseSignal(userText)) {
            const matchedCase = await resolveReturnToExistingCase({
              userId,
              userText,
            });

            if (matchedCase) {
              const matchedCaseSignal = await getLatestCaseSignalSnapshot(
                matchedCase.id,
                matchedCase,
              );
              console.log("CASE_RETURN_MATCH", {
                userId,
                conversationId: convoId,
                previousResolvedCaseId: resolvedActiveCase?.id ?? null,
                matchedCaseId: matchedCase.id,
                derivedMovementContext: derivedCaseContext.movementContext,
                derivedActivityType: derivedCaseContext.activityType,
              });

              resolvedActiveCase = matchedCase;
              returnToCaseMatched = true;
              continuityContextAllowed = true;
              continuityContextReason = "explicit_return_to_case";
              continuityLatestBodyRegion = matchedCaseSignal.bodyRegion;
              continuityLatestMovementContext =
                matchedCaseSignal.movementContext;
              continuityLatestActivityType = matchedCaseSignal.activityType;
              continuityLatestSignalType = matchedCaseSignal.signalType;
            }
          }

          if (resolvedActiveCase && !returnToCaseMatched) {
            logLayer1Trace(layer1TraceId, "resolved_active_case_before_boundary", {
              conversationId: convoId,
              caseId: resolvedActiveCase.id,
              status: resolvedActiveCase.status,
              movementContext: resolvedActiveCase.movementContext,
              activityType: resolvedActiveCase.activityType,
              derivedCaseContext,
              derivedBodyRegion,
              derivedSignalType,
            });
            const boundaryDecision = await shouldStartNewCaseForSignal({
              userText,
              currentCase: resolvedActiveCase,
              derivedMovementContext: derivedCaseContext.movementContext,
              derivedActivityType: derivedCaseContext.activityType,
              derivedBodyRegion,
              derivedSignalType,
            });
            logLayer1Trace(layer1TraceId, "case_boundary_decision", {
              conversationId: convoId,
              currentCaseId: resolvedActiveCase.id,
              shouldStartNewCase: boundaryDecision.shouldStartNewCase,
              reason: boundaryDecision.reason,
              derivedBodyRegion: boundaryDecision.bodyRegion,
              previousBodyRegion: boundaryDecision.previousBodyRegion,
              derivedMovementContext: boundaryDecision.movementContext,
              previousMovementContext: boundaryDecision.previousMovementContext,
              derivedMovementFamily: boundaryDecision.derivedMovementFamily,
              previousMovementFamily: boundaryDecision.previousMovementFamily,
              derivedSignalType: boundaryDecision.signalType,
              previousSignalType: boundaryDecision.previousSignalType,
              derivedActivityType: boundaryDecision.activityType,
              previousActivityType: boundaryDecision.previousActivityType,
            });
            console.log("CASE_BOUNDARY_DECISION", {
              userId,
              conversationId: convoId,
              currentCaseId: resolvedActiveCase.id,
              shouldStartNewCase: boundaryDecision.shouldStartNewCase,
              reason: boundaryDecision.reason,
              derivedBodyRegion: boundaryDecision.bodyRegion,
              previousBodyRegion: boundaryDecision.previousBodyRegion,
              derivedMovementContext: boundaryDecision.movementContext,
              previousMovementContext: boundaryDecision.previousMovementContext,
              derivedMovementFamily: boundaryDecision.derivedMovementFamily,
              previousMovementFamily: boundaryDecision.previousMovementFamily,
              derivedSignalType: boundaryDecision.signalType,
              previousSignalType: boundaryDecision.previousSignalType,
              derivedActivityType: boundaryDecision.activityType,
              previousActivityType: boundaryDecision.previousActivityType,
            });

            continuityLatestBodyRegion =
              boundaryDecision.previousBodyRegion ?? null;
            continuityLatestMovementContext =
              boundaryDecision.previousMovementContext ?? null;
            continuityLatestActivityType =
              boundaryDecision.previousActivityType ?? null;
            continuityLatestSignalType =
              boundaryDecision.previousSignalType ?? null;

            if (boundaryDecision.shouldStartNewCase) {
              previousCaseIdForNewCase = resolvedActiveCase.id;
              console.log("CASE_BOUNDARY_NEW_CASE", {
                userId,
                conversationId: convoId,
                previousCaseId: resolvedActiveCase.id,
                reason: boundaryDecision.reason,
                derivedCaseContext,
                derivedBodyRegion,
                derivedSignalType,
              });
              resolvedActiveCase = null;
              continuityContextAllowed = false;
              continuityContextReason = boundaryDecision.reason ?? "case_boundary_split";
            } else {
              continuityContextAllowed = true;
              continuityContextReason = boundaryDecision.reason ?? "same_case_fit";
            }
          } else if (!resolvedActiveCase) {
            logLayer1Trace(layer1TraceId, "case_boundary_decision", {
              conversationId: convoId,
              currentCaseId: null,
              shouldStartNewCase: true,
              reason: "new_case_no_prior_case_fit",
              derivedCaseContext,
              derivedBodyRegion,
              derivedSignalType,
            });
            continuityContextAllowed = false;
            continuityContextReason = "new_case_no_prior_case_fit";
          } else if (returnToCaseMatched) {
            logLayer1Trace(layer1TraceId, "case_boundary_decision", {
              conversationId: convoId,
              currentCaseId: resolvedActiveCase.id,
              shouldStartNewCase: false,
              reason: "explicit_return_to_case",
              derivedCaseContext,
              derivedBodyRegion,
              derivedSignalType,
            });
          }

          if (resolvedActiveCase) {
            await writeCaseSignalIfNew({
              userId,
              caseId: resolvedActiveCase.id,
              description: userText,
              activityType: derivedCaseContext.activityType,
              movementContext: derivedCaseContext.movementContext,
              bodyRegion: derivedBodyRegion,
              signalType: derivedSignalType,
            });

            const caseUpdate: {
              updatedAt: Date;
              activityType?: string;
              movementContext?: string;
            } = { updatedAt: new Date() };

            if (
              hasExplicitActivityInText(userText) &&
              isMeaningfulCaseBoundaryValue(derivedCaseContext.activityType) &&
              normalizeCaseKey(derivedCaseContext.activityType) !==
                normalizeCaseKey(resolvedActiveCase.activityType)
            ) {
              caseUpdate.activityType = derivedCaseContext.activityType;
              if (
                isMeaningfulCaseBoundaryValue(
                  derivedCaseContext.movementContext,
                )
              ) {
                caseUpdate.movementContext = derivedCaseContext.movementContext;
              }
              console.log("CASE_ACTIVITY_CORRECTED_FROM_SIGNAL", {
                caseId: resolvedActiveCase.id,
                previousActivityType: resolvedActiveCase.activityType,
                nextActivityType: derivedCaseContext.activityType,
              });
            }

            await db
              .update(cases)
              .set(caseUpdate)
              .where(eq(cases.id, resolvedActiveCase.id));
          } else {
            let newCase: ResolvedCaseRow | undefined;

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
              isNewCase = shouldCreateCase && !returnToCaseMatched;

              try {
                await writeCaseSignalIfNew({
                  userId,
                  caseId: newCase.id,
                  description: userText,
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

      console.log("NEW_CASE_ISOLATION", {
        isNewCase,
        previousCaseId: previousCaseIdForNewCase,
        newCaseId: resolvedActiveCase?.id ?? null,
      });

      if (!resolvedActiveCase) {
        resolvedActiveCase = await getConversationOpenCase(userId, convoId);
      }

      if (
        !shouldCreateCase &&
        resolvedActiveCase &&
        continuityContextAllowed
      ) {
        const latestContinuitySignal = await getLatestCaseSignalSnapshot(
          resolvedActiveCase.id,
          resolvedActiveCase,
        );
        continuityLatestBodyRegion = latestContinuitySignal.bodyRegion;
        continuityLatestMovementContext =
          latestContinuitySignal.movementContext;
        continuityLatestActivityType = latestContinuitySignal.activityType;
        continuityLatestSignalType = latestContinuitySignal.signalType;
      }

      const shouldInjectStoredContext =
        !shouldCreateCase || continuityContextAllowed;
      const memoryBlock = shouldInjectStoredContext
        ? buildMemoryPromptBlock(memory)
        : "";
      const currentConversationSummaryBlock =
        shouldInjectStoredContext
          ? await getCurrentConversationSummaryBlock(convoId)
          : "";

      const continuityCaseId =
        !isNewCase && continuityContextAllowed && resolvedActiveCase
          ? resolvedActiveCase.id
          : null;
      if (continuityCaseId) {
        console.log("CONTINUITY_CONTEXT_ALLOWED", {
          userId,
          conversationId: convoId,
          currentCaseId: continuityCaseId,
          reason: continuityContextReason,
          derivedBodyRegion,
          latestCaseBodyRegion: continuityLatestBodyRegion,
          derivedActivityType: derivedCaseContext?.activityType ?? null,
          latestCaseActivityType: continuityLatestActivityType,
          derivedMovementContext: derivedCaseContext?.movementContext ?? null,
          latestCaseMovementContext: continuityLatestMovementContext,
          derivedSignalType,
          latestCaseSignalType: continuityLatestSignalType,
        });
      } else {
        console.log("CONTINUITY_CONTEXT_BLOCKED", {
          userId,
          conversationId: convoId,
          currentCaseId: resolvedActiveCase?.id ?? null,
          reason: continuityContextReason,
          derivedBodyRegion,
          latestCaseBodyRegion: continuityLatestBodyRegion,
          derivedActivityType: derivedCaseContext?.activityType ?? null,
          latestCaseActivityType: continuityLatestActivityType,
          derivedMovementContext: derivedCaseContext?.movementContext ?? null,
          latestCaseMovementContext: continuityLatestMovementContext,
          derivedSignalType,
          latestCaseSignalType: continuityLatestSignalType,
        });
      }

      console.log("CHAT_START", {
        userId,
        conversationId: convoId,
        caseId: resolvedActiveCase?.id ?? null,
      });

      let internalCasePersistResult: InternalCasePersistResult = {
        attempted: false,
        wroteHypothesis: false,
        wroteAdjustment: false,
        wroteOutcome: false,
        update: null,
      };
      let shouldRunInternalCaseEngine = false;

      if (!isCaseReview && resolvedActiveCase) {
        shouldRunInternalCaseEngine =
          !hasLaneOutcomeFeedback &&
          (shouldCreateCase || dependsOnPriorConversationContext(userText));
        logLayer1Trace(layer1TraceId, "layer1_run_decision", {
          conversationId: convoId,
          caseId: resolvedActiveCase.id,
          ran: shouldRunInternalCaseEngine,
          skipped: !shouldRunInternalCaseEngine,
          shouldCreateCase,
          internalOutcomeResult,
          dependsOnPriorContext: dependsOnPriorConversationContext(userText),
        });

        if (hasLaneOutcomeFeedback) {
          console.log("OUTCOME_NO_LAYER1", {
            caseId: resolvedActiveCase?.id,
          });
          console.log("LAYER1_START", {
            caseId: resolvedActiveCase.id,
            skipped: true,
            reason: "outcome_feedback",
          });
        } else if (shouldRunInternalCaseEngine) {
          try {
            console.log("LAYER1_START", {
              caseId: resolvedActiveCase.id,
            });

            const internalCaseUpdate = await runInternalCaseEngine({
              openaiClient: openai,
              traceId: layer1TraceId,
              userText,
              currentCase: resolvedActiveCase,
              derivedBodyRegion,
              derivedActivityType:
                derivedCaseContext?.activityType ??
                resolvedActiveCase.activityType,
              derivedMovementContext:
                derivedCaseContext?.movementContext ??
                resolvedActiveCase.movementContext,
              derivedSignalType,
              outcomeResult: internalOutcomeResult,
            });

            internalCasePersistResult = await persistInternalCaseUpdate({
              userId,
              traceId: layer1TraceId,
              caseId: resolvedActiveCase.id,
              update: internalCaseUpdate,
              userText,
            });
            console.log("EXTRACT_RESULT", {
              caseId: resolvedActiveCase.id,
              foundHypothesis: Boolean(internalCaseUpdate.hypothesis),
              foundAdjustment: Boolean(internalCaseUpdate.adjustment),
              foundTest: Boolean(internalCaseUpdate.currentTest),
              foundOutcome: Boolean(internalCaseUpdate.outcomeStatus),
            });
            console.log("WRITE_RESULT", {
              caseId: resolvedActiveCase.id,
              hypothesisWrite: internalCasePersistResult.wroteHypothesis,
              adjustmentWrite: internalCasePersistResult.wroteAdjustment,
              outcomeWrite: internalCasePersistResult.wroteOutcome,
              skippedReason:
                internalCasePersistResult.wroteHypothesis ||
                internalCasePersistResult.wroteAdjustment ||
                internalCasePersistResult.wroteOutcome
                  ? null
                  : "no_structured_write",
            });
          } catch (err) {
            console.error("INTERNAL_CASE_ENGINE_FAILED", {
              userId,
              conversationId: convoId,
              caseId: resolvedActiveCase.id,
              ...formatUnknownError(err),
            });
          }
        } else {
          console.log("LAYER1_START", {
            caseId: resolvedActiveCase.id,
            skipped: true,
          });
        }
      } else {
        logLayer1Trace(layer1TraceId, "layer1_run_decision", {
          conversationId: convoId,
          caseId: resolvedActiveCase?.id ?? null,
          ran: false,
          skipped: true,
          reason: isCaseReview ? "case_review" : "no_resolved_active_case",
          shouldCreateCase,
        });
      }

      if (!isCaseReview && hasLaneOutcomeFeedback) {
        const outcomeRoutingLabels = getOutcomeRoutingLabels(
          userText,
          internalOutcomeResult,
        );
        const outcomeCase = resolvedActiveCase;
        const validAdjustment =
          outcomeCase
            ? await getValidAdjustmentForOutcomeWrite({
                caseId: outcomeCase.id,
              })
            : null;
        let routedOutcomePersisted = internalCasePersistResult.wroteOutcome;

        if (
          outcomeCase &&
          outcomeRoutingLabels &&
          !routedOutcomePersisted
        ) {
          const [latestOutcome] = await db
            .select({
              id: caseOutcomes.id,
              result: caseOutcomes.result,
              adjustmentId: caseOutcomes.adjustmentId,
              createdAt: caseOutcomes.createdAt,
            })
            .from(caseOutcomes)
            .where(eq(caseOutcomes.caseId, outcomeCase.id))
            .orderBy(desc(caseOutcomes.id))
            .limit(1);
          const latestCreatedAtMs = latestOutcome?.createdAt
            ? new Date(latestOutcome.createdAt).getTime()
            : 0;
          const isDuplicateRecentOutcome =
            Boolean(latestOutcome) &&
            latestOutcome?.result === outcomeRoutingLabels.storedResult &&
            latestOutcome?.adjustmentId === (validAdjustment?.id ?? null) &&
            latestCreatedAtMs > 0 &&
            Date.now() - latestCreatedAtMs <= 1000 * 60 * 10;

          if (!isDuplicateRecentOutcome) {
            await db.insert(caseOutcomes).values({
              caseId: outcomeCase.id,
              adjustmentId: validAdjustment?.id ?? null,
              result: outcomeRoutingLabels.storedResult,
              userFeedback: userText,
            });
            routedOutcomePersisted = true;
          }
        }

        console.log("OUTCOME_FEEDBACK_PERSISTENCE", {
          outcomeCaseId: outcomeCase?.id ?? null,
          activeAdjustmentId: validAdjustment?.id ?? null,
          outcomeLabel: outcomeRoutingLabels?.logLabel ?? null,
          persisted: routedOutcomePersisted,
          reason: routedOutcomePersisted
            ? "persisted"
            : !outcomeCase
              ? "no_current_conversation_case"
              : !outcomeRoutingLabels
                ? "no_supported_outcome_label"
                : "duplicate_or_insert_skipped",
          rawOutcomePreview: clampText(userText, 180),
        });
      }

      const caseLaneDecision = classifyCaseLaneDecisionForLog({
        userText,
        shouldCreateCase,
        hasOutcomeFeedback: hasLaneOutcomeFeedback,
      });
      const createsInvestigativeCase =
        !isCaseReview &&
        caseLaneDecision.lane === "investigation_case" &&
        Boolean(resolvedActiveCase) &&
        (shouldCreateCase ||
          hasLaneOutcomeFeedback ||
          shouldRunInternalCaseEngine);

      console.log("CASE_LANE_DECISION", {
        lane: createsInvestigativeCase
          ? "investigation_case"
          : "conversation_only",
        reason: createsInvestigativeCase
          ? caseLaneDecision.reason
          : caseLaneDecision.lane === "conversation_only"
            ? caseLaneDecision.reason
            : "unclear",
        confidence: createsInvestigativeCase
          ? caseLaneDecision.confidence
          : caseLaneDecision.lane === "conversation_only"
            ? caseLaneDecision.confidence
            : 0.5,
        createsCase: createsInvestigativeCase,
        caseId: createsInvestigativeCase ? resolvedActiveCase?.id ?? null : null,
      });

      const activeHypothesisBlock = continuityCaseId
        ? isNewCase
          ? ""
          : await getActiveHypothesisBlock(userId, continuityCaseId)
        : "";
      const runtimePatternBlock = continuityCaseId
        ? isNewCase
          ? ""
          : await getDominantRuntimePatternBlock(userId, continuityCaseId)
        : "";
      const continuityBlock = internalCasePersistResult.update
        ? ""
        : isNewCase
          ? ""
          : activeHypothesisBlock || runtimePatternBlock;
      const structuredCaseStateBlock =
        !isCaseReview && resolvedActiveCase
          ? await buildStructuredCaseStateBlock(
              resolvedActiveCase.id,
              internalCasePersistResult.update,
              layer1TraceId,
              isNewCase,
            )
          : "";
      const settingsContextBlock = !isCaseReview
        ? buildSettingsContextBlock(persistedSettingsForContext)
        : "";
      const shouldUseSettingsInitialization =
        !isCaseReview &&
        isTrueNewUserForInitialization({
          resolvedActiveCase,
          memory,
          storedMessages: storedMessagesBeforeCurrentTurn,
        });
      const settingsInitializationEmphasisBlock =
        buildSettingsInitializationEmphasisBlock(
          shouldUseSettingsInitialization,
        );

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

        ${settingsContextBlock}

        ${settingsInitializationEmphasisBlock}

        ${currentConversationSummaryBlock}

        ${memoryBlock}

        ${continuityBlock}

        ${structuredCaseStateBlock}

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

      const assistantText = await runCompletion(openai, chatMessages);

      if (!isCaseReview) {
        console.log("ARC_VALIDATOR_START", {
          stage: "initial",
          assistantTextLength: assistantText.length,
        });
        const arcViolationReasons =
          getResponseArcViolationReasons(assistantText);
        console.log("ARC_VALIDATOR_RESULT", {
          stage: "initial",
          violates: arcViolationReasons.length > 0,
          reasons: arcViolationReasons,
        });

        if (arcViolationReasons.length > 0) {
          console.log("ARC_VALIDATOR_LOG_ONLY_MODE", {
            stage: "initial",
            reasons: arcViolationReasons,
            finalTextLength: assistantText.length,
          });
        }
      }

      const layer2State = internalCasePersistResult.update;
      const layer2CaseId = layer2State ? resolvedActiveCase?.id ?? null : null;
      const rawLayer2ActiveTest =
        layer2State?.activeTest ?? layer2State?.currentTest ?? null;
      const rawLayer2ActiveLever =
        layer2State?.activeLever ?? layer2State?.singleLever ?? null;
      const staleLayer2StateSuppressed =
        Boolean(layer2State) &&
        Boolean(resolvedActiveCase) &&
        layer2CaseId !== resolvedActiveCase?.id;
      const layer2ActiveTest = staleLayer2StateSuppressed
        ? null
        : rawLayer2ActiveTest;
      const layer2ActiveLever = staleLayer2StateSuppressed
        ? null
        : rawLayer2ActiveLever;
      console.log("ACTIVE_CASE_STATE_SELECTION", {
        resolvedActiveCaseId: resolvedActiveCase?.id ?? null,
        layer2CaseId,
        activeTestCaseId: layer2ActiveTest ? layer2CaseId : null,
        activeLeverCaseId: layer2ActiveLever ? layer2CaseId : null,
        outcomeCaseId: layer2State?.outcomeStatus ? layer2CaseId : null,
        usingActiveTest: Boolean(layer2ActiveTest),
        activeTestPreview: clampText(layer2ActiveTest ?? "", 180),
        staleActiveTestSuppressed: staleLayer2StateSuppressed,
      });
      const layer2Enforcement = enforceLayer2BehavioralCompleteness({
        text: assistantText,
        hypothesis: layer2State?.hypothesis,
        interpretationCorrection: layer2State?.interpretationCorrection,
        failurePrediction: layer2State?.failurePrediction,
        activeLever: layer2ActiveLever,
        activeTest: layer2ActiveTest,
      });
      let finalText = layer2Enforcement.text;
      const leverEnforced = enforceSingleLever({
        text: finalText,
        activeLever: layer2ActiveLever,
        activeTest: layer2ActiveTest,
      });

      if (leverEnforced.modified) {
        finalText = leverEnforced.text;
        console.log("LAYER2_SINGLE_LEVER_ENFORCED", {
          caseId: resolvedActiveCase?.id ?? null,
          reason: leverEnforced.reason,
          originalLength: layer2Enforcement.text.length,
          finalLength: finalText.length,
        });
      }

      const structuredLabelCleanup = stripStructuredLayer2Labels(finalText);
      finalText = structuredLabelCleanup.text;

      const coachingCleanup = cleanCoachingLanguage(finalText);
      finalText = coachingCleanup.text;

      const userInputNonEnglish = detectNonEnglishOutput(userText);
      const nonEnglishDetected =
        !userInputNonEnglish && detectNonEnglishOutput(finalText);

      if (nonEnglishDetected) {
        finalText = buildEnglishLayer2Fallback({
          interpretationCorrection: layer2State?.interpretationCorrection,
          hypothesis: layer2State?.hypothesis,
          activeLever: layer2ActiveLever,
          activeTest: layer2ActiveTest,
        });
      }

      const outcomeExpression = enforceOutcomeFeedbackExpression({
        text: finalText,
        outcomeResult: hasLaneOutcomeFeedback ? internalOutcomeResult : null,
      });
      finalText = outcomeExpression.text;

      console.log("LAYER2_FORMAT_CLEANUP", {
        caseId: resolvedActiveCase?.id ?? null,
        strippedLabels: structuredLabelCleanup.stripped,
        coachingCleaned: coachingCleanup.cleaned,
        nonEnglishDetected,
        singleLeverForced: leverEnforced.modified,
        outcomeFeedbackCompressed: outcomeExpression.modified,
        originalLength: assistantText.length,
        finalLength: finalText.length,
      });

      console.log("LAYER2_ENFORCER_RESULT", {
        caseId: resolvedActiveCase?.id ?? null,
        repaired: layer2Enforcement.repaired,
        reasons: layer2Enforcement.reasons,
        hasHypothesis: Boolean(layer2State?.hypothesis),
        hasActiveTest: Boolean(
          layer2State?.activeTest ?? layer2State?.currentTest,
        ),
        hasClosure: hasOutcomeFeedbackClosure(finalText),
        originalLength: assistantText.length,
        finalLength: finalText.length,
      });

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
        const driftReasons = [
          !isValidResponse(assistantText) ? "invalid_response_shape" : null,
          isWeak ? "weak_response_language" : null,
          hasWeakMechanismLanguage ? "weak_mechanism_language" : null,
          isGenericSuccess ? "generic_success_language" : null,
          closureDrift ? "closure_drift" : null,
          hasLabels ? "visible_labels" : null,
          hasFormattedSections ? "formatted_sections" : null,
        ].filter((reason): reason is string => Boolean(reason));

        if (driftReasons.length > 0) {
          console.log("ARC_VALIDATOR_LOG_ONLY_MODE", {
            stage: "narrative_drift",
            reasons: driftReasons,
            finalTextLength: assistantText.length,
          });
        }
      }

      if (!isCaseReview) {
        console.log("ARC_VALIDATOR_START", {
          stage: "final_before_stream",
          finalTextLength: finalText.length,
        });
        const finalArcViolationReasons =
          getResponseArcViolationReasons(finalText);
        console.log("ARC_VALIDATOR_RESULT", {
          stage: "final_before_stream",
          violates: finalArcViolationReasons.length > 0,
          reasons: finalArcViolationReasons,
        });
        if (
          finalArcViolationReasons.some((reason) =>
            reason.startsWith("banned_coach_language:"),
          )
        ) {
          console.warn("ARC_VALIDATOR_BLOCKED_EXERCISE_PRESCRIPTION", {
            stage: "final_before_stream",
            finalTextLength: finalText.length,
            reasons: finalArcViolationReasons.filter((reason) =>
              reason.startsWith("banned_coach_language:"),
            ),
          });
        }

        if (finalArcViolationReasons.length > 0) {
          console.log("ARC_VALIDATOR_LOG_ONLY_MODE", {
            stage: "final_before_stream",
            reasons: finalArcViolationReasons,
            finalTextLength: finalText.length,
          });
        }

        const visibleCurrentTest = resolvedActiveCase
          ? await getVisibleCurrentTestFromCaseState(
              resolvedActiveCase.id,
              internalCasePersistResult.update,
            )
          : null;

        if (
          visibleCurrentTest &&
          !responseIncludesCurrentTest(finalText, visibleCurrentTest)
        ) {
          logLayer1Trace(layer1TraceId, "visible_response_arc_observation", {
            conversationId: convoId,
            caseId: resolvedActiveCase?.id ?? null,
            reason: "visible_current_test_missing",
            visibleCurrentTest: clampText(visibleCurrentTest, 220),
            finalTextLength: finalText.length,
          });
          console.log("ARC_VALIDATOR_LOG_ONLY_MODE", {
            stage: "visible_current_test_missing",
            reasons: ["visible_current_test_missing"],
            finalTextLength: finalText.length,
          });
        } else if (visibleCurrentTest) {
          console.log("ARC_CASE_STATE_TEST_INCLUDED", {
            caseId: resolvedActiveCase?.id ?? null,
            finalTextLength: finalText.length,
          });
        }

        const latestCaseHypothesisForTestOnly =
          resolvedActiveCase && visibleCurrentTest
            ? await getLatestValidHypothesisForCase(resolvedActiveCase.id)
            : null;
        const hasHypothesisForTestOnly = Boolean(
          internalCasePersistResult.update?.hypothesis ||
            latestCaseHypothesisForTestOnly?.hypothesis,
        );

        if (
          visibleCurrentTest &&
          hasHypothesisForTestOnly &&
          isTestOnlyResponse(finalText, visibleCurrentTest)
        ) {
          logLayer1Trace(layer1TraceId, "visible_response_arc_observation", {
            conversationId: convoId,
            caseId: resolvedActiveCase?.id ?? null,
            reason: "test_only_response_with_hypothesis",
            visibleCurrentTest: clampText(visibleCurrentTest, 220),
            finalTextLength: finalText.length,
          });
          console.log("ARC_TEST_ONLY_DETECTED", {
            caseId: resolvedActiveCase?.id ?? null,
            hasHypothesis: true,
            triggered: true,
          });
          console.log("ARC_VALIDATOR_LOG_ONLY_MODE", {
            stage: "test_only_response_with_hypothesis",
            reasons: ["test_only_response_with_hypothesis"],
            finalTextLength: finalText.length,
          });
        }
      }

      console.log("FINAL_TEXT_FOR_STREAM", {
        isCaseReview,
        finalTextLength: finalText.length,
      });
      logLayer1Trace(layer1TraceId, "visible_response_final", {
        conversationId: convoId,
        caseId: resolvedActiveCase?.id ?? null,
        isCaseReview,
        finalTextLength: finalText.length,
        finalTextPreview: clampText(finalText, 500),
      });

      res.setHeader("Content-Type", "text/event-stream");

      const words = finalText.split(" ");

      for (const word of words) {
        res.write(`data: ${JSON.stringify({ content: word + " " })}\n\n`);
      }

      if (!isCaseReview) {
        await db.insert(messages).values({
          conversationId: convoId,
          userId: userId,
          role: "assistant",
          content: finalText,
        });
      }

      const extractionResponseType = classifyAssistantResponseForExtraction({
        isCaseReview,
        text: finalText,
      });

      console.log("FINAL_TEXT_FOR_EXTRACTION", {
        type: extractionResponseType,
        isCaseReview,
        finalTextLength: finalText.length,
      });

      console.log("EXTRACT_TYPE_DETECTED", {
        type: extractionResponseType,
        isCaseReview,
        assistantTextLength: finalText.length,
      });

      if (extractionResponseType === "case_review") {
        console.log("EXTRACT_SKIPPED_CASE_REVIEW", {
          assistantTextLength: finalText.length,
        });
      }

      const shouldRunAssistantExtractionFallback =
        extractionResponseType === "investigation" &&
        !internalCasePersistResult.attempted;
      logLayer1Trace(layer1TraceId, "assistant_text_extraction_fallback_decision", {
        conversationId: convoId,
        caseId: resolvedActiveCase?.id ?? null,
        extractionResponseType,
        internalCaseAttempted: internalCasePersistResult.attempted,
        shouldRunAssistantExtractionFallback,
      });

      if (
        extractionResponseType === "investigation" &&
        internalCasePersistResult.attempted
      ) {
        console.log("EXTRACT_SKIPPED_ASSISTANT_TEXT_PRIMARY_INTERNAL_STATE", {
          caseId: resolvedActiveCase?.id ?? null,
          wroteHypothesis: internalCasePersistResult.wroteHypothesis,
          wroteAdjustment: internalCasePersistResult.wroteAdjustment,
          wroteOutcome: internalCasePersistResult.wroteOutcome,
        });
      }

      if (shouldRunAssistantExtractionFallback) {
        try {
          if (
            resolvedActiveCase &&
            isOpenCaseStatus(resolvedActiveCase.status)
          ) {
            console.log("EXTRACT_START", {
              caseId: resolvedActiveCase.id,
              assistantTextLength: finalText.length,
            });

            let validHypothesis = await getLatestValidHypothesisForCase(
              resolvedActiveCase.id,
            );

            const hypothesisSentence = extractFirstMatchingSentence(finalText, [
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
            /\bleading to\b/i,
            /\bresulting in\b/i,
            /\bcontributing to\b/i,
            /\bwhich was affecting\b/i,
            /\bat rest leading\b/i,
            /\breduced circulation\b/i,
            /\breduced mobility\b/i,
            /\blimiting\b/i,
            /\bpreventing\b/i,
            /\binhibiting\b/i,
            /\brestricting\b/i,
            /\breduced\b[^.!?]{1,80}\bduring\b/i,
            /\bloss of\b[^.!?]{1,80}\bduring\b/i,
            ]);

            console.log("EXTRACT_HYPOTHESIS_CANDIDATE", {
              caseId: resolvedActiveCase.id,
              startsWithIssue: /^The issue is that\b/i.test(finalText.trim()),
              hypothesisSentence,
              candidateLength: hypothesisSentence?.length ?? 0,
            });

            if (
              hypothesisSentence &&
              isStrongHypothesisCandidate(hypothesisSentence)
            ) {
              console.log("EXTRACT_HYPOTHESIS_FOUND", {
                caseId: resolvedActiveCase.id,
                hypothesisSentence,
              });

              const [latestStoredHypothesis] = await db
                .select({
                  id: caseHypotheses.id,
                  hypothesis: caseHypotheses.hypothesis,
                })
                .from(caseHypotheses)
                .where(eq(caseHypotheses.caseId, resolvedActiveCase.id))
                .orderBy(desc(caseHypotheses.id))
                .limit(1);

              if (
                !areEquivalentDashboardCandidates(
                  hypothesisSentence,
                  latestStoredHypothesis?.hypothesis,
                )
              ) {
                const [insertedHypothesis] = await db
                  .insert(caseHypotheses)
                  .values({
                    caseId: resolvedActiveCase.id,
                    hypothesis: hypothesisSentence,
                  })
                  .returning({
                    id: caseHypotheses.id,
                    hypothesis: caseHypotheses.hypothesis,
                  });

                if (isValidStoredHypothesis(insertedHypothesis)) {
                  validHypothesis = insertedHypothesis;
                  console.log("EXTRACT_WRITE_SUCCESS", {
                    type: "hypothesis",
                    caseId: resolvedActiveCase.id,
                    hypothesisId: insertedHypothesis.id,
                  });
                }
              } else if (isValidStoredHypothesis(latestStoredHypothesis)) {
                validHypothesis = latestStoredHypothesis;
              }
            } else if (hypothesisSentence) {
              console.log("EXTRACT_HYPOTHESIS_SKIPPED_WEAK", {
                caseId: resolvedActiveCase.id,
                hypothesisSentence,
              });
            } else {
              console.log("EXTRACT_HYPOTHESIS_NOT_FOUND", {
                caseId: resolvedActiveCase.id,
                finalTextPreview: clampText(finalText, 220),
              });
            }

            if (!validHypothesis) {
              console.log("EXTRACT_WRITE_FAIL", {
                type: "adjustment",
                caseId: resolvedActiveCase.id,
                reason: "no_valid_hypothesis",
              });
            } else {
              const adjustmentSentence = extractFirstMatchingSentence(finalText, [
              /^\s*try\b/i,
              /^\s*test\b/i,
              /^\s*use\b/i,
              /^\s*focus on\b/i,
              /^\s*keep\b/i,
              /^\s*make sure\b/i,
              /^\s*let\b/i,
              /^\s*allow\b/i,
              /^\s*shift\b/i,
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
              /^\s*reduce\b/i,
              /^\s*increase\b/i,
              /^\s*shorten\b/i,
              /^\s*lengthen\b/i,
              /^\s*soften\b/i,
              /^\s*slow\b/i,
              /\b(?:try|test|use|focus on|keep|make sure|let|allow|shift|load|relax|drive|control|rotate|brace|stack|press|pull|push|hinge|hold|stay|reduce|increase|shorten|lengthen|soften|slow)\b/i,
              ], { rejectMechanismSentences: true });

              const mechanicalFocusCandidate =
                extractFirstMatchingSentence(finalText, [
                  /\b(?:change|shift|load|brace|stack|rotate|hold|release|drive|hinge|press|pull|push|clear)\b/i,
                  /\b(?:hip|hips|rib|ribs|pelvis|trunk|shoulder|shoulders|back|spine|foot|feet|ankle|knee|knees|glute|glutes|serve|swing|contact|backswing|pressure|weight|chest|torso|lat|lats|core|elbow|wrist|stride|step|gait|walk|walking|tension|range|position|speed|tempo)\b/i,
                ]) ?? adjustmentSentence;
              const mechanicalFocus =
                mechanicalFocusCandidate &&
                hasRealMechanicalLever(mechanicalFocusCandidate)
                  ? mechanicalFocusCandidate
                  : adjustmentSentence;

              if (adjustmentSentence) {
                console.log("EXTRACT_ADJUSTMENT_FOUND", {
                  caseId: resolvedActiveCase.id,
                  adjustmentSentence,
                });
              }

              if (adjustmentSentence && isTestLikeText(adjustmentSentence)) {
                console.log("EXTRACT_TEST_FOUND", {
                  caseId: resolvedActiveCase.id,
                  currentTest: adjustmentSentence,
                });
              }

              const candidateTest = adjustmentSentence ?? mechanicalFocus;
              const latestSignalSnapshot =
                resolvedActiveCase
                  ? await getLatestCaseSignalSnapshot(
                      resolvedActiveCase.id,
                      resolvedActiveCase,
                    )
                  : null;
              let { finalTest } = enforceConcreteTestCandidate({
                caseId: resolvedActiveCase.id,
                candidate: candidateTest,
                userText,
                hypothesis: validHypothesis.hypothesis,
                movementContext:
                  latestSignalSnapshot?.movementContext ??
                  resolvedActiveCase.movementContext,
                bodyRegion: latestSignalSnapshot?.bodyRegion ?? null,
                activityType:
                  latestSignalSnapshot?.activityType ??
                  resolvedActiveCase.activityType,
              });

              if (!isValidConcreteTest(finalTest)) {
                finalTest = buildFallbackConcreteTest({
                  userText,
                  hypothesis: validHypothesis.hypothesis,
                  movementContext:
                    latestSignalSnapshot?.movementContext ??
                    resolvedActiveCase.movementContext,
                  bodyRegion: latestSignalSnapshot?.bodyRegion ?? null,
                  activityType:
                    latestSignalSnapshot?.activityType ??
                    resolvedActiveCase.activityType,
                });
                const fallbackRejectionReason = getAdjustmentContextRejectionReason({
                  candidate: finalTest,
                  userText,
                  movementContext:
                    latestSignalSnapshot?.movementContext ??
                    resolvedActiveCase.movementContext,
                  bodyRegion: latestSignalSnapshot?.bodyRegion ?? null,
                  activityType:
                    latestSignalSnapshot?.activityType ??
                    resolvedActiveCase.activityType,
                });
                if (fallbackRejectionReason) {
                  finalTest =
                    "Do 3 slow reps of the movement that triggered it and change one thing: start from the hips before the trunk moves. Tell me what changes.";
                }
                console.log("TEST_VALIDATION_RESULT", {
                  caseId: resolvedActiveCase.id,
                  valid: false,
                  usedFallback: true,
                });
                console.log("TEST_WRITE_READY", {
                  caseId: resolvedActiveCase.id,
                  preview: finalTest.slice(0, 80),
                });
                console.log("CORRECTIVE_ADJUSTMENT_SOURCE", {
                  selectedCaseId: resolvedActiveCase.id,
                  adjustmentId: null,
                  adjustmentCaseId: resolvedActiveCase.id,
                  source: "deterministic_fallback",
                  textPreview: clampText(finalTest, 180),
                  rejectedStaleAdjustment: Boolean(fallbackRejectionReason),
                  rejectionReason: fallbackRejectionReason,
                });
                console.log("DRIVE_SERVE_FALLBACK_GUARD", {
                  caseId: resolvedActiveCase.id,
                  candidatePreview: clampText(finalTest, 180),
                  explicitDriveServeContext: hasExplicitDriveServeContext(
                    userText,
                    latestSignalSnapshot?.movementContext ??
                      resolvedActiveCase.movementContext,
                    latestSignalSnapshot?.bodyRegion ?? null,
                    latestSignalSnapshot?.activityType ??
                      resolvedActiveCase.activityType,
                  ),
                  accepted: !fallbackRejectionReason,
                  rejectionReason: fallbackRejectionReason,
                });
              }

              const adjustmentWriteRejectionReason =
                getAdjustmentContextRejectionReason({
                  candidate: finalTest,
                  userText,
                  movementContext:
                    latestSignalSnapshot?.movementContext ??
                    resolvedActiveCase.movementContext,
                  bodyRegion: latestSignalSnapshot?.bodyRegion ?? null,
                  activityType:
                    latestSignalSnapshot?.activityType ??
                    resolvedActiveCase.activityType,
                });

              console.log("ADJUSTMENT_WRITE_CONTEXT_GUARD", {
                caseId: resolvedActiveCase.id,
                movementContext:
                  latestSignalSnapshot?.movementContext ??
                  resolvedActiveCase.movementContext,
                activityType:
                  latestSignalSnapshot?.activityType ??
                  resolvedActiveCase.activityType,
                bodyRegion: latestSignalSnapshot?.bodyRegion ?? null,
                candidatePreview: clampText(finalTest ?? "", 180),
                accepted: !adjustmentWriteRejectionReason,
                rejectionReason: adjustmentWriteRejectionReason,
              });

              if (adjustmentWriteRejectionReason) {
                console.log("EXTRACT_WRITE_FAIL", {
                  type: "adjustment",
                  caseId: resolvedActiveCase.id,
                  reason: adjustmentWriteRejectionReason,
                });
              } else {
                const [latestStoredAdjustment] = await db
                  .select({
                    id: caseAdjustments.id,
                    cue: caseAdjustments.cue,
                    mechanicalFocus: caseAdjustments.mechanicalFocus,
                    hypothesisId: caseAdjustments.hypothesisId,
                  })
                  .from(caseAdjustments)
                  .where(eq(caseAdjustments.caseId, resolvedActiveCase.id))
                  .orderBy(desc(caseAdjustments.id))
                  .limit(1);

                const isDuplicateAdjustment =
                  areSameAdjustmentText(
                    finalTest,
                    latestStoredAdjustment?.cue,
                  ) ||
                  areSameAdjustmentText(
                    finalTest,
                    latestStoredAdjustment?.mechanicalFocus,
                  );

                if (!isDuplicateAdjustment) {
                  const [insertedAdjustment] = await db
                    .insert(caseAdjustments)
                    .values({
                      caseId: resolvedActiveCase.id,
                      hypothesisId: validHypothesis.id,
                      cue: finalTest,
                      mechanicalFocus: finalTest,
                    })
                    .returning({
                      id: caseAdjustments.id,
                    });
                  console.log("EXTRACT_WRITE_SUCCESS", {
                    type: "adjustment",
                    caseId: resolvedActiveCase.id,
                    adjustmentId: insertedAdjustment?.id ?? null,
                  });
                  if (latestStoredAdjustment?.id) {
                    console.log("INTERNAL_ADJUSTMENT_REPLACED_ACTIVE", {
                      caseId: resolvedActiveCase.id,
                      previousAdjustmentId: latestStoredAdjustment.id,
                      newAdjustmentId: insertedAdjustment?.id ?? null,
                      previousPreview: clampText(
                        pickDashboardDisplayValue([
                          latestStoredAdjustment.cue,
                          latestStoredAdjustment.mechanicalFocus,
                        ]) ?? "",
                        180,
                      ),
                      newPreview: clampText(finalTest, 180),
                    });
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error("EXTRACT_WRITE_FAIL", {
            type: "case_extraction",
            error: err,
          });
        }

        try {
          const outcomeResult = detectOutcomeResult(userText);

          if (outcomeResult) {
            if (!resolvedActiveCase) {
              resolvedActiveCase = await getConversationOpenCase(userId, convoId);
            }

            const activeCase = resolvedActiveCase;

            if (activeCase && isOpenCaseStatus(activeCase.status)) {
              const validAdjustment = await getValidAdjustmentForOutcomeWrite({
                caseId: activeCase.id,
              });

              if (!validAdjustment) {
                console.log("EXTRACT_WRITE_FAIL", {
                  type: "outcome",
                  caseId: activeCase.id,
                  result: outcomeResult,
                  reason: "no_valid_adjustment",
                });
              } else {
                const [latestOutcome] = await db
                  .select({
                    id: caseOutcomes.id,
                    result: caseOutcomes.result,
                    adjustmentId: caseOutcomes.adjustmentId,
                    createdAt: caseOutcomes.createdAt,
                  })
                  .from(caseOutcomes)
                  .where(eq(caseOutcomes.adjustmentId, validAdjustment.id))
                  .orderBy(desc(caseOutcomes.id))
                  .limit(1);

                const latestCreatedAtMs = latestOutcome?.createdAt
                  ? new Date(latestOutcome.createdAt).getTime()
                  : 0;

                const isDuplicateRecentOutcome =
                  Boolean(latestOutcome) &&
                  String(latestOutcome.result ?? "") === outcomeResult &&
                  latestOutcome?.adjustmentId === validAdjustment.id &&
                  latestCreatedAtMs > 0 &&
                  Date.now() - latestCreatedAtMs <= 1000 * 60 * 10;

                if (!isDuplicateRecentOutcome) {
                  const [insertedOutcome] = await db
                    .insert(caseOutcomes)
                    .values({
                      caseId: activeCase.id,
                      adjustmentId: validAdjustment.id,
                      result: outcomeResult,
                      userFeedback: userText,
                    })
                    .returning({
                      id: caseOutcomes.id,
                    });
                  console.log("EXTRACT_OUTCOME_FOUND", {
                    caseId: activeCase.id,
                    adjustmentId: validAdjustment.id,
                    result: outcomeResult,
                  });
                  console.log("EXTRACT_WRITE_SUCCESS", {
                    type: "outcome",
                    caseId: activeCase.id,
                    outcomeId: insertedOutcome?.id ?? null,
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
          }
        } catch (err) {
          console.error("Auto outcome capture failed:", err);
        }
      }

      try {
        if (isCaseReview && finalText.length > 60) {
          const caseReviewTarget = await resolveCaseReviewTargetCase({
            userId,
            conversationId: convoId,
            currentCase: resolvedActiveCase,
          });

          if (caseReviewTarget) {
            await writeCaseReview({
              userId,
              caseId: caseReviewTarget.id,
              reviewText: finalText,
            });
          } else {
            console.warn(
              "CASE REVIEW SKIPPED: no valid case target found for user",
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
        const validAdjustment =
          resolvedActiveCase && isOpenCaseStatus(resolvedActiveCase.status)
            ? await getValidAdjustmentForOutcomeWrite({
                caseId: resolvedActiveCase.id,
              })
            : null;

        const shouldWriteAdjustment =
          userText.length > 30 &&
          looksLikeAdjustment(userText) &&
          Boolean(validAdjustment);

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
        const validAdjustment =
          resolvedActiveCase && isOpenCaseStatus(resolvedActiveCase.status)
            ? await getValidAdjustmentForOutcomeWrite({
                caseId: resolvedActiveCase.id,
              })
            : null;

        const shouldWriteOutcome =
          userText.length > 20 &&
          looksLikeOutcome(userText) &&
          Boolean(validAdjustment);

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
        if (!isCaseReview) {
          const summaryContext = await buildSessionSummaryContext({
            userId,
            conversationId: convoId,
            userText,
            finalText,
            resolvedActiveCase,
            isCaseReview,
          });
          const summarySeed = `
          Session summary target:
          Preserve the issue under investigation, active or likely mechanism, current test or adjustment, latest outcome or shift, and what remains unresolved.

          Latest completed turn:
          User: ${userText}
          Assistant: ${finalText}

          Session state context:
          ${summaryContext.join("\n")}
                    `.trim();

          const summary = await generateSessionSummary(summarySeed, []);

          await db
            .update(conversations)
            .set({ summary })
            .where(eq(conversations.id, convoId));
        }
      } catch (err) {
        console.error("Summary generation failed:", err);
      }

      console.log("CHAT_DONE", {
        caseId: resolvedActiveCase?.id ?? null,
        durationMs: Date.now() - chatStartedAt,
      });

      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (err) {
      console.error("CHAT ERROR:", err);
      const formatted = formatUnknownError(err);
      res.status(500).json(formatted);
    }
  });

  // ==============================
  // OUTCOME API
  // ==============================

  app.post("/api/outcome", async (req: Request, res: Response) => {
    try {
      const { caseId, adjustmentId, result, userFeedback } = req.body ?? {};
      const numericCaseId = Number(caseId);
      const numericAdjustmentId =
        adjustmentId == null ? null : Number(adjustmentId);

      if (!Number.isFinite(numericCaseId) || !result) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      if (
        adjustmentId != null &&
        (!Number.isFinite(numericAdjustmentId) || !numericAdjustmentId)
      ) {
        return res.status(400).json({ error: "Invalid adjustmentId" });
      }

      const validAdjustment = await getValidAdjustmentForOutcomeWrite({
        caseId: numericCaseId,
        adjustmentId: numericAdjustmentId,
      });

      if (!validAdjustment) {
        return res.status(409).json({
          error:
            "Outcome requires a valid adjustment tied to a valid hypothesis",
        });
      }

      await db.insert(caseOutcomes).values({
        caseId: numericCaseId,
        adjustmentId: validAdjustment.id,
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
          .where(eq(cases.id, numericCaseId));
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("Outcome capture failed:", err);
      res.status(500).json({ error: "Failed to store outcome" });
    }
  });
}

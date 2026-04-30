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
import { eq, asc, desc, and, ne, isNull, sql } from "drizzle-orm";

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

    { label: "golf swing", regex: /\bgolf swing\b/i },
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

  if (
    isMeaningfulCaseBoundaryValue(previousBodyRegion) &&
    isMeaningfulCaseBoundaryValue(derivedBodyRegion) &&
    normalizeOptionalLabel(previousBodyRegion) !==
      normalizeOptionalLabel(derivedBodyRegion)
  ) {
    return {
      shouldStartNewCase: true,
      reason: `body_region_shift:${previousBodyRegion}->${derivedBodyRegion}`,
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
      shouldStartNewCase: true,
      reason: `signal_type_shift:${previousSignalType}->${derivedSignalType}`,
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
      shouldStartNewCase: true,
      reason: `movement_context_shift:${previousMovementContext}->${derivedMovementContext}`,
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
      reason: `activity_type_shift:${previousActivityType}->${derivedActivityType}`,
      ...derived,
      ...previous,
    };
  }

  return {
    shouldStartNewCase: false,
    reason: "same_case_fit",
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

  if (/\bdrive[-\s]?serve|drive serves|serve|serving|racquetball\b/i.test(source)) {
    const direction = /\bleft\b/i.test(source) ? " to the left" : "";
    return `Do 3 slow drive-serve motions${direction} without a ball. Stay tall through the finish. Tell me if the ${regionPhrase} starts during load, rotation, or after release.`;
  }

  const movement = normalizePreviewValue(movementContext);
  if (movement && !isFallbackMovementContext(movement)) {
    return `Do 3 slow ${movement} motions without a ball. Change only one variable: stay tall through the motion. Tell me if the ${regionPhrase} appears during setup, during movement, or after the rep.`;
  }

  return `Do 3 slow reps of the movement that triggered it. Change only one variable. Tell me if the ${regionPhrase} appears during setup, during the movement, or after the rep.`;
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

  console.log("TEST_VALIDATION_RESULT", {
    caseId,
    valid: false,
    usedFallback: true,
  });
  console.log("TEST_WRITE_READY", {
    caseId,
    preview: fallback.slice(0, 80),
  });

  return { finalTest: fallback, usedFallback: true, reason };
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
    .flatMap((value) => value.split(/\s+—\s+/))
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

type InternalCaseUpdate = {
  signal: string | null;
  bodyRegion: string | null;
  activityType: string | null;
  movementContext: string | null;
  hypothesis: string | null;
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
  const outcomeStatusFromDetector =
    fallback.outcomeResult === "Improved"
      ? "improved"
      : fallback.outcomeResult === "Worse"
        ? "worse"
        : fallback.outcomeResult === "Same"
          ? "same"
          : null;

  return {
    signal:
      stringOrNull(raw?.signal, 800) ??
      (qualifiesForTimelineSignal(fallback.userText)
        ? clampText(fallback.userText, 800)
        : null),
    bodyRegion:
      stringOrNull(raw?.bodyRegion, 80) ?? fallback.derivedBodyRegion ?? null,
    activityType:
      stringOrNull(raw?.activityType, 80) ??
      fallback.derivedActivityType ??
      null,
    movementContext:
      stringOrNull(raw?.movementContext, 80) ??
      fallback.derivedMovementContext ??
      null,
    hypothesis: stringOrNull(raw?.hypothesis, 400),
    adjustment: stringOrNull(raw?.adjustment, 320),
    currentTest: stringOrNull(raw?.currentTest, 320),
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

async function runInternalCaseEngine({
  openaiClient,
  userText,
  currentCase,
  derivedBodyRegion,
  derivedActivityType,
  derivedMovementContext,
  derivedSignalType,
  outcomeResult,
}: {
  openaiClient: OpenAI;
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

  console.log("LAYER1_OUTPUT", {
    caseId: currentCase.id,
    bodyRegion: update.bodyRegion,
    activity: update.activityType,
    hypothesis: clampText(update.hypothesis ?? "", 120),
    adjustment: clampText(update.adjustment ?? "", 120),
    currentTest: clampText(update.currentTest ?? "", 120),
    outcome: clampText(update.outcome ?? "", 120),
    outcomeStatus: update.outcomeStatus,
  });

  return update;
}

async function persistInternalCaseUpdate({
  userId,
  caseId,
  update,
  userText,
}: {
  userId: string;
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
    .select({ id: caseSignals.id, description: caseSignals.description })
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

  let activeHypothesis = await getLatestValidHypothesisForCase(caseId);

  if (update.hypothesis && !isGenericCoachingFillerText(update.hypothesis)) {
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
          signalId: latestSignal?.id ?? null,
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

  if (activeHypothesis?.id) {
    const { finalTest } = enforceConcreteTestCandidate({
      caseId,
      candidate: nextTest,
      userText,
      hypothesis: activeHypothesis.hypothesis,
      movementContext: update.movementContext,
      bodyRegion: update.bodyRegion,
      activityType: update.activityType,
    });
    const adjustmentCue = finalTest;
    const mechanicalFocus = finalTest;

    const [latestStoredAdjustment] = await db
      .select({
        cue: caseAdjustments.cue,
        mechanicalFocus: caseAdjustments.mechanicalFocus,
      })
      .from(caseAdjustments)
      .where(eq(caseAdjustments.caseId, caseId))
      .orderBy(desc(caseAdjustments.id))
      .limit(1);

    const isDuplicateAdjustment =
      areEquivalentDashboardCandidates(
        adjustmentCue,
        latestStoredAdjustment?.cue,
      ) ||
      areEquivalentDashboardCandidates(
        mechanicalFocus,
        latestStoredAdjustment?.mechanicalFocus,
      );

    if (!isDuplicateAdjustment) {
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

      result.wroteAdjustment = true;
      console.log("INTERNAL_ADJUSTMENT_WRITE", {
        caseId,
        status: "inserted",
        adjustmentId: insertedAdjustment?.id ?? null,
        hypothesisId: activeHypothesis.id,
        cuePreview: clampText(adjustmentCue, 180),
        mechanicalFocusPreview: clampText(mechanicalFocus, 180),
      });
      console.log("INTERNAL_CASE_WRITE_SUCCESS", {
        type: "adjustment",
        caseId,
        adjustmentId: insertedAdjustment?.id ?? null,
      });
    } else {
      console.log("INTERNAL_ADJUSTMENT_WRITE", {
        caseId,
        status: "duplicate_skipped",
        hypothesisId: activeHypothesis.id,
        cuePreview: clampText(adjustmentCue, 180),
        mechanicalFocusPreview: clampText(mechanicalFocus, 180),
      });
    }
  } else {
    console.log("INTERNAL_ADJUSTMENT_WRITE", {
      caseId,
      status: "skipped_no_hypothesis",
      hasNextTest: Boolean(nextTest),
      hasActiveHypothesis: Boolean(activeHypothesis?.id),
      nextTestPreview: clampText(nextTest ?? "", 180),
    });
  }

  if (update.outcomeStatus && update.outcomeStatus !== "unknown") {
    const mappedOutcome =
      update.outcomeStatus === "improved"
        ? "Improved"
        : update.outcomeStatus === "worse"
          ? "Worse"
          : "Same";
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

        if (mappedOutcome === "Improved") {
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

  return result;
}

async function buildStructuredCaseStateBlock(
  caseId: number,
  internalUpdate: InternalCaseUpdate | null,
): Promise<string> {
  const snapshot = await buildInternalCaseStateSnapshot(caseId);
  const visibleStateInput = {
    caseId,
    signal: internalUpdate?.signal ?? snapshot.latestSignal ?? null,
    bodyRegion: internalUpdate?.bodyRegion ?? null,
    activityType: internalUpdate?.activityType ?? null,
    movementContext: internalUpdate?.movementContext ?? null,
    hypothesis: internalUpdate?.hypothesis ?? snapshot.latestHypothesis ?? null,
    adjustment:
      internalUpdate?.currentTest ??
      internalUpdate?.adjustment ??
      snapshot.latestAdjustment ??
      null,
    outcome: internalUpdate?.outcome ?? snapshot.latestOutcome ?? null,
  };

  console.log("VISIBLE_RESPONSE_INPUT", {
    caseId,
    hasHypothesis: Boolean(visibleStateInput.hypothesis),
    hasAdjustment: Boolean(visibleStateInput.adjustment),
    hasCurrentTest: Boolean(visibleStateInput.adjustment),
  });

  return `
=== STRUCTURED CASE STATE ===
This is the internal case engine state. Use it as source-of-truth context.
The visible response may be selective and natural; it does not need to expose every field.

Signal: ${internalUpdate?.signal ?? snapshot.latestSignal ?? "none"}
Body region: ${internalUpdate?.bodyRegion ?? "unknown"}
Activity: ${internalUpdate?.activityType ?? "unknown"}
Movement context: ${internalUpdate?.movementContext ?? "unknown"}
Current hypothesis: ${
    internalUpdate?.hypothesis ?? snapshot.latestHypothesis ?? "none"
  }
Current adjustment/test: ${
    internalUpdate?.currentTest ??
    internalUpdate?.adjustment ??
    snapshot.latestAdjustment ??
    "none"
  }
Latest outcome: ${internalUpdate?.outcome ?? snapshot.latestOutcome ?? "none"}

Response rule:
- Speak from this structured state.
- Do not write for extraction.
- Do not force every structured field into the visible reply.
- Select the next useful user-facing move: breakdown, tight correction, lever, probe, or clarification.
`;
}

function cleanMechanismSummary(hypothesis: string | null | undefined): string {
  const normalized = normalizePreviewValue(hypothesis);
  if (!normalized) return "";

  const cleaned = normalized
    .replace(/^the issue is that\s*/i, "")
    .replace(/^the issue is\s*/i, "")
    .trim();

  if (!cleaned) return "";

  return clampText(cleaned.charAt(0).toUpperCase() + cleaned.slice(1), 220);
}

async function buildResponseFromCaseState(
  caseId: number,
  internalUpdate: InternalCaseUpdate | null,
): Promise<string> {
  const snapshot = await buildInternalCaseStateSnapshot(caseId);
  const hypothesis =
    internalUpdate?.hypothesis ?? snapshot.latestHypothesis ?? null;
  const currentTest =
    internalUpdate?.currentTest ??
    internalUpdate?.adjustment ??
    snapshot.latestAdjustment ??
    null;

  const mechanismLine = cleanMechanismSummary(hypothesis);
  const testLine = normalizePreviewValue(currentTest);

  return [mechanismLine, testLine].filter(Boolean).join("\n\n").trim();
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
        .limit(2);

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

      if (selectedCase) {
        [latestAdjustment] = await db
          .select({
            caseId: caseAdjustments.caseId,
            mechanicalFocus: caseAdjustments.mechanicalFocus,
            cue: caseAdjustments.cue,
            hypothesisId: caseAdjustments.hypothesisId,
          })
          .from(caseAdjustments)
          .innerJoin(
            caseHypotheses,
            eq(caseAdjustments.hypothesisId, caseHypotheses.id),
          )
          .where(eq(caseAdjustments.caseId, selectedCase.id))
          .orderBy(desc(caseAdjustments.id))
          .limit(1);

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

        console.log("DASHBOARD_SELECTED_CASE", {
          userId,
          selectedCaseId: selectedCase.id,
          movementContext: selectedCase.movementContext,
          activityType: selectedCase.activityType,
          status: selectedCase.status,
        });
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

      const caseReviewsList = await db
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

      console.log("CASE_REVIEWS_LOADED", {
        count: caseReviewsList.length,
      });

      const activeCaseTitle = buildActiveCaseTitle(
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

      const testSourceCandidates = [
        pickDashboardDisplayValue([
          latestAdjustment?.cue,
          latestAdjustment?.mechanicalFocus,
        ]),
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
          value: pickDashboardDisplayValue([
            latestAdjustment?.cue,
            latestAdjustment?.mechanicalFocus,
          ]),
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

      console.log("DASHBOARD_CASE_STATE_READ", {
        caseId: selectedCase?.id ?? null,
        hypothesisCount: latestHypothesis ? 1 : 0,
        adjustmentCount: latestAdjustment ? 1 : 0,
        outcomeCount: latestOutcome ? 1 : 0,
        hasCurrentTest: Boolean(currentTest),
        investigationState,
      });

      res.json({
        activeCaseTitle,
        investigationState,
        signal: latestSignal?.description ?? null,
        hypothesis: latestHypothesis?.hypothesis ?? null,
        adjustment: pickDashboardDisplayValue([
          latestAdjustment?.cue,
          latestAdjustment?.mechanicalFocus,
        ]),
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

      // ==============================
      // DOMAIN BOUNDARY GATE
      // ==============================
      const isMedicalSystemic =
        !isCaseReview && isMedicalSystemicSignal(userText);
      const hasNocturnalSupport = hasNocturnalMedicalContext(userText);

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

      const memory = await getMemory(userId);
      const persistedSettingsForContext = buildPersistedSettings(
        existingUser?.firstName,
        memory,
        (existingUser as any)?.profileImageUrl,
      );
      const shouldCreateCase =
        !isCaseReview && qualifiesForTimelineSignal(userText);
      const derivedCaseContext = shouldCreateCase
        ? deriveCaseContext(userText, persistedSettingsForContext)
        : null;
      const derivedBodyRegion = shouldCreateCase
        ? deriveBodyRegion(userText)
        : null;
      const derivedSignalType = shouldCreateCase
        ? deriveSignalType(userText)
        : null;
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
            const boundaryDecision = await shouldStartNewCaseForSignal({
              userText,
              currentCase: resolvedActiveCase,
              derivedMovementContext: derivedCaseContext.movementContext,
              derivedActivityType: derivedCaseContext.activityType,
              derivedBodyRegion,
              derivedSignalType,
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
            continuityContextAllowed = false;
            continuityContextReason = "new_case_no_prior_case_fit";
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

            await db
              .update(cases)
              .set({ updatedAt: new Date() })
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
        continuityContextAllowed && resolvedActiveCase
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

      if (!isCaseReview && resolvedActiveCase) {
        const internalOutcomeResult = detectOutcomeResult(userText);
        const shouldRunInternalCaseEngine =
          shouldCreateCase ||
          Boolean(internalOutcomeResult) ||
          dependsOnPriorConversationContext(userText);

        if (shouldRunInternalCaseEngine) {
          try {
            console.log("LAYER1_START", {
              caseId: resolvedActiveCase.id,
            });

            const internalCaseUpdate = await runInternalCaseEngine({
              openaiClient: openai,
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
      }

      const activeHypothesisBlock = continuityCaseId
        ? await getActiveHypothesisBlock(userId, continuityCaseId)
        : "";
      const runtimePatternBlock = continuityCaseId
        ? await getDominantRuntimePatternBlock(userId, continuityCaseId)
        : "";
      const continuityBlock = activeHypothesisBlock || runtimePatternBlock;
      const structuredCaseStateBlock =
        !isCaseReview && resolvedActiveCase
          ? await buildStructuredCaseStateBlock(
              resolvedActiveCase.id,
              internalCasePersistResult.update,
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

      let assistantText = await runCompletion(openai, chatMessages);

      if (!isCaseReview) {
        console.log("ARC_VALIDATOR_START", {
          stage: "initial",
          assistantTextLength: assistantText.length,
        });
        let arcViolationReasons = getResponseArcViolationReasons(assistantText);
        console.log("ARC_VALIDATOR_RESULT", {
          stage: "initial",
          violates: arcViolationReasons.length > 0,
          reasons: arcViolationReasons,
        });

        if (arcViolationReasons.length > 0) {
          console.log("ARC_RETRY_START", {
            stage: "initial",
            assistantTextLength: assistantText.length,
            reasons: arcViolationReasons,
          });

          assistantText = await runCompletion(openai, [
            ...chatMessages,
            {
              role: "assistant",
              content: assistantText,
            },
            {
              role: "user",
              content: `
Your previous response violated the Interloop response arc.

Rewrite it now.

Required:

* controlled validation only if earned
* one mechanism
* one interpretation correction
* one predicted failure or overcorrection
* one movement-based lever
* no exercise prescription
* no generic coaching
* no broad advice
* no multiple levers
* one sharp question only if useful

The response must not say:

* focus on strengthening
* work on stability
* improve control
* perform exercises
* do wall slides

The lever must be a movement cue, not a training recommendation.

Produce the corrected response only.
            `.trim(),
            },
          ]);

          arcViolationReasons = getResponseArcViolationReasons(assistantText);
          console.log("ARC_RETRY_RESULT", {
            stage: "initial",
            assistantTextLength: assistantText.length,
            violates: arcViolationReasons.length > 0,
            reasons: arcViolationReasons,
          });
        }
      }

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

=== RETRY PRIORITY ===

Do not default to immediate diagnosis.
Do not force the phrase "The issue is..."
Do not make every response diagnosis-first.

Choose the right shape:

1. Mechanism-led:
- name one specific mechanism
- correct the user's interpretation
- predict a localized failure point
- give one movement-based lever
- end with one single-rep probe

2. Probe-first:
- briefly name the uncertainty
- give one single-rep probe that separates two possible failure points
- ask for one specific observable result

If the mechanism is not fully clear, start with a targeted probe instead.
If the previous response identified a mechanism, refine or test it instead of restating it.

=== MECHANISM ENFORCEMENT ===

All explanations, when given, must resolve to a physical or mechanical cause.

Do NOT say:
- this is working
- this is aligning well
- this is a good sign
- this means you're doing it right
- this suggests progress

Instead:
- identify what is physically happening in the body
- describe what is breaking, collapsing, shifting, or compensating
- explain the mechanism directly

When the user reports improvement:
- refine the current mechanism instead of restating it
- narrow where the failure moved
- change the lever or probe to target the new failure point

Do not collapse success into praise, reassurance, or closure.

=== RESPONSE SHAPE ===

Preserve the natural Interloop arc:

1. Validate only what is actually correct
2. Decide whether this turn needs mechanism-led or probe-first handling
3. If mechanism-led, correct the mechanism and predict a localized failure
4. If probe-first, isolate the missing variable
5. Reduce to one lever or one probe
6. End according to state, with at most one final question only if needed

Keep one dominant mechanism only.
Do not reopen multiple explanations or branches.
Do not restate the whole problem from scratch.
Do not explain broadly when a precise correction is available.
Do not use bolded headers, titled sections, bullets, or packaged formatting in the visible response.

If the mechanism is already established, advance it instead of restating it.
If new evidence breaks the mechanism, replace it rather than stacking explanations.
If feedback says it helped first and failed later, localize the later failure instead of repeating the first explanation.

The response must read as one continuous explanation with natural paragraphing.

Natural phrasing is allowed. The response is valid if it either gives a specific mechanism or asks a targeted probe that will reveal the mechanism.

=== ENDING STATE ===

The ending question is determined by state, not by template.

- If the user is lightly reopening the conversation, use soft re-entry from continuity when it exists.
- If the mechanism is still unclear, end with a narrowing question about where, when, load, timing, or condition.
- If the mechanism is forming but not proven, end with a confirmation or falsification question.
- Only if an actual adjustment has already been introduced may the ending question test whether it holds or what changed.
- If no adjustment exists, do not ask an adjustment-testing question.
- If the user clearly closes the point, do not ask a follow-up question.

A closure response can be very short if it lands cleanly.
A light release line is allowed only if it does not probe, test, clarify, or restart the investigation.

=== NAME AND TONE ===

Do not force name usage.
Use the name only when it adds meaning or emphasis.
Do not attach the name to the final question by default.
Prefer omitting the name over using it habitually.

Do not sound generic, therapeutic, motivational, or like a normal assistant.
The response should feel slightly corrective and willing to challenge the user's framing when needed.

Produce the corrected response now.
                `.trim(),
            },
          ];

          finalText = await runCompletion(openai, retryMessages);
        }
      }

      if (!isCaseReview) {
        console.log("ARC_VALIDATOR_START", {
          stage: "final_before_stream",
          finalTextLength: finalText.length,
        });
        let finalArcViolationReasons =
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
          console.log("ARC_RETRY_START", {
            stage: "final_before_stream",
            finalTextLength: finalText.length,
            reasons: finalArcViolationReasons,
          });

          finalText = await runCompletion(openai, [
            ...chatMessages,
            {
              role: "assistant",
              content: finalText,
            },
            {
              role: "user",
              content: `
Your previous response is still invalid.

Rewrite it from the hidden reasoning arc, then express only what is needed.

Internal arc:
1. Extract the real signal
2. Test multiple interpretations
3. Identify the mechanism
4. Correct the user's interpretation if needed
5. Predict the likely failure or overcorrection if useful
6. Extract one lever if useful

Visible output may be:
- full breakdown
- tight correction
- single lever
- probe

Do not force all arc components into the visible response.
Do not force "The issue is..."
Do not use the same rhythm every time.
Only ask a question if it sharpens the model.

Never say:
- focus on exercises
- focus on strengthening
- work on stability
- strengthen
- improve stability
- improve control
- perform exercises
- do 3 sets
- practice
- higher speeds

Return only the corrected response.
              `.trim(),
            },
          ]);

          finalArcViolationReasons = getResponseArcViolationReasons(finalText);
          console.log("ARC_RETRY_RESULT", {
            stage: "final_before_stream",
            finalTextLength: finalText.length,
            violates: finalArcViolationReasons.length > 0,
            reasons: finalArcViolationReasons,
          });
        }

        if (finalArcViolationReasons.length > 0) {
          console.error("ARC_FINAL_INVALID_BLOCKED", {
            finalTextLength: finalText.length,
            reasons: finalArcViolationReasons,
          });

          const caseStateFallback = resolvedActiveCase
            ? await buildResponseFromCaseState(
                resolvedActiveCase.id,
                internalCasePersistResult.update,
              )
            : "";

          if (caseStateFallback) {
            finalText = caseStateFallback;
            console.log("ARC_CASE_STATE_FALLBACK_USED", {
              caseId: resolvedActiveCase?.id ?? null,
              finalTextLength: finalText.length,
              hasCurrentTest: Boolean(
                internalCasePersistResult.update?.currentTest ||
                  internalCasePersistResult.update?.adjustment,
              ),
            });
          } else {
            finalText =
              "Does it break before the weight shift or after?";
          }
        }
      }

      console.log("FINAL_TEXT_FOR_STREAM", {
        isCaseReview,
        finalTextLength: finalText.length,
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
                console.log("TEST_VALIDATION_RESULT", {
                  caseId: resolvedActiveCase.id,
                  valid: false,
                  usedFallback: true,
                });
                console.log("TEST_WRITE_READY", {
                  caseId: resolvedActiveCase.id,
                  preview: finalTest.slice(0, 80),
                });
              }

              const [latestStoredAdjustment] = await db
                .select({
                  cue: caseAdjustments.cue,
                  mechanicalFocus: caseAdjustments.mechanicalFocus,
                  hypothesisId: caseAdjustments.hypothesisId,
                })
                .from(caseAdjustments)
                .where(eq(caseAdjustments.caseId, resolvedActiveCase.id))
                .orderBy(desc(caseAdjustments.id))
                .limit(1);

              const isDuplicateAdjustment =
                areEquivalentDashboardCandidates(
                  finalTest,
                  latestStoredAdjustment?.cue,
                ) ||
                areEquivalentDashboardCandidates(
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

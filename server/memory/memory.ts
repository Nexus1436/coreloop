import { db } from "../db.ts";
import { userMemory, timelineEntries, caseReviews } from "@shared/schema";
import { eq, desc } from "drizzle-orm";

/* =====================================================
   MEMORY TYPE
===================================================== */

export interface InterloopMemory {
  identity: {
    name: string | null;
    dominantHand: "left" | "right" | null;
    age: number | null;
    height: string | null;
    weight: string | null;
  };

  anthropometry: {
    limbLengthBias: string | null;
    notes: string[];
  };

  body: {
    injuries: {
      location: string;
      severity: string;
      status: "active" | "historical";
    }[];
    chronicTensionZones: string[];
    instabilityZones: string[];
  };

  sportContext: {
    primarySport: string | null;
    secondarySports: string[];
    yearsExperience: number | null;
    competitionLevel: string | null;
  };

  movementPatterns: {
    confirmed: string[];
    suspected: string[];
    recurringThemes: string[];
  };

  signalHistory: {
    recurringPainSignals: string[];
    recurringConfusionSignals: string[];
    fearTriggers: string[];
  };

  experiments: {
    successful: string[];
    failed: string[];
    neutral: string[];
  };

  performanceTrends: {
    improvements: string[];
    regressions: string[];
    consistencyNotes: string[];
  };

  cognitivePatterns: {
    overanalysis: boolean;
    rushTendency: boolean;
    hesitationPattern: boolean;
    notes: string[];
  };

  sessionMeta: {
    totalSessions: number;
    lastSession: string | null;
  };
}

/* =====================================================
   DEFAULT MEMORY FACTORY
===================================================== */

function createDefaultMemory(): InterloopMemory {
  return {
    identity: {
      name: null,
      dominantHand: null,
      age: null,
      height: null,
      weight: null,
    },

    anthropometry: {
      limbLengthBias: null,
      notes: [],
    },

    body: {
      injuries: [],
      chronicTensionZones: [],
      instabilityZones: [],
    },

    sportContext: {
      primarySport: null,
      secondarySports: [],
      yearsExperience: null,
      competitionLevel: null,
    },

    movementPatterns: {
      confirmed: [],
      suspected: [],
      recurringThemes: [],
    },

    signalHistory: {
      recurringPainSignals: [],
      recurringConfusionSignals: [],
      fearTriggers: [],
    },

    experiments: {
      successful: [],
      failed: [],
      neutral: [],
    },

    performanceTrends: {
      improvements: [],
      regressions: [],
      consistencyNotes: [],
    },

    cognitivePatterns: {
      overanalysis: false,
      rushTendency: false,
      hesitationPattern: false,
      notes: [],
    },

    sessionMeta: {
      totalSessions: 0,
      lastSession: null,
    },
  };
}

/* =====================================================
   MEMORY LOADER
===================================================== */

export async function getMemory(userId: string): Promise<InterloopMemory> {
  const rows = await db
    .select()
    .from(userMemory)
    .where(eq(userMemory.userId, userId))
    .limit(1);

  if (rows.length === 0) {
    const memory = createDefaultMemory();

    await db.insert(userMemory).values({
      userId,
      memory,
    });

    return memory;
  }

  const existing = rows[0].memory as InterloopMemory;

  return {
    ...createDefaultMemory(),
    ...existing,
  };
}

/* =====================================================
   MEMORY UPDATER
===================================================== */

export async function updateMemory(
  userId: string,
  updater: (memory: InterloopMemory) => void,
): Promise<void> {
  const memory = await getMemory(userId);

  updater(memory);

  await db
    .update(userMemory)
    .set({
      memory,
      updatedAt: new Date(),
    })
    .where(eq(userMemory.userId, userId));
}

/* =====================================================
   MEMORY PROMPT BLOCK
===================================================== */

export function buildMemoryPromptBlock(memory: InterloopMemory): string {
  const lines: string[] = [];

  if (memory.identity.name) {
    lines.push(`Name: ${memory.identity.name}`);
  }

  if (memory.sportContext.primarySport) {
    lines.push(`Primary sport: ${memory.sportContext.primarySport}`);
  }

  if (
    Array.isArray(memory.movementPatterns.recurringThemes) &&
    memory.movementPatterns.recurringThemes.length > 0
  ) {
    lines.push("Recurring themes:");
    for (const theme of memory.movementPatterns.recurringThemes.slice(0, 6)) {
      lines.push(`- ${theme}`);
    }
  }

  if (
    Array.isArray(memory.body.chronicTensionZones) &&
    memory.body.chronicTensionZones.length > 0
  ) {
    lines.push(
      `Chronic tension zones: ${memory.body.chronicTensionZones.slice(0, 6).join(", ")}`,
    );
  }

  if (
    Array.isArray(memory.body.instabilityZones) &&
    memory.body.instabilityZones.length > 0
  ) {
    lines.push(
      `Instability zones: ${memory.body.instabilityZones.slice(0, 6).join(", ")}`,
    );
  }

  if (lines.length === 0) return "";

  return `=== USER MEMORY ===\n${lines.join("\n")}`;
}

/* =====================================================
   DURABLE MEMORY FILTER
===================================================== */

export function filterDurableMemory(
  extracted: Record<string, any>,
): Record<string, any> {
  const allowed: Record<string, any> = {};

  for (const key of Object.keys(extracted)) {
    const value = extracted[key];

    if (!value) continue;

    if (key.startsWith("identity.")) {
      allowed[key] = value;
      continue;
    }

    if (key.startsWith("sportContext.")) {
      allowed[key] = value;
      continue;
    }

    if (
      key.startsWith("movementPatterns.") ||
      key.startsWith("signalHistory.")
    ) {
      if (Array.isArray(value) && value.length > 0) {
        allowed[key] = value;
      }
      continue;
    }
  }

  return allowed;
}

/* =====================================================
   MERGE EXTRACTED MEMORY
===================================================== */

export function mergeExtracted(memory: any, extracted: Record<string, any>) {
  const filtered = filterDurableMemory(extracted);

  for (const key of Object.keys(filtered)) {
    const value = filtered[key];

    if (value === undefined || value === null) continue;

    const path = key.split(".");
    let target = memory;

    for (let i = 0; i < path.length - 1; i++) {
      const p = path[i];

      if (!target[p] || typeof target[p] !== "object") {
        target[p] = {};
      }

      target = target[p];
    }

    const finalKey = path[path.length - 1];

    if (Array.isArray(value)) {
      if (!Array.isArray(target[finalKey])) {
        target[finalKey] = [];
      }

      const set = new Set(target[finalKey]);

      for (const item of value) {
        set.add(item);
      }

      target[finalKey] = Array.from(set);
      continue;
    }

    target[finalKey] = value;
  }
}

/* =====================================================
   TIMELINE WRITER
===================================================== */

export async function writeTimelineEntry(params: {
  userId: string;
  conversationId: number;
  type?: "signal" | "adjustment" | "outcome" | "pattern" | "event";
  summary: string;
  metadata?: any;
}) {
  if (!params.summary || params.summary.trim().length < 20) return;

  await db.insert(timelineEntries).values({
    userId: params.userId,
    conversationId: params.conversationId,
    summary: params.summary.trim(),
    type: params.type ?? null,
    metadata: params.metadata ?? null,
  });
}

/* =====================================================
   CASE REVIEW WRITER
===================================================== */

export async function writeCaseReview(params: {
  userId: string;
  caseId: number;
  reviewText: string;
}) {
  if (!params.reviewText || params.reviewText.length < 40) return;

  await db.insert(caseReviews).values({
    userId: params.userId,
    caseId: params.caseId,
    reviewText: params.reviewText,
  });
}

function extractFirstMatch(text: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const re = new RegExp(`\\b${pattern}\\b`, "i");
    const match = text.match(re);
    if (match?.[0]) return match[0].toLowerCase();
  }
  return null;
}

function buildRecurringSignalCandidate(summary: string): string | null {
  const input = summary.trim().toLowerCase();
  if (!input) return null;

  const bodyPart = extractFirstMatch(input, [
    "shoulder",
    "back",
    "neck",
    "hip",
    "knee",
    "ankle",
    "elbow",
    "wrist",
    "lat",
    "tricep",
    "arm",
    "core",
    "trunk",
  ]);

  const issue = extractFirstMatch(input, [
    "pain",
    "tight",
    "tightness",
    "hurt",
    "hurts",
    "off",
    "instability",
    "strain",
    "stiff",
    "stiffness",
    "compensation",
    "uncomfortable",
  ]);

  const context = extractFirstMatch(input, [
    "backhand",
    "forehand",
    "swing",
    "serve",
    "follow through",
    "follow-through",
    "setup",
    "run",
    "running",
    "walk",
    "walking",
    "squat",
    "deadlift",
    "press",
    "rotation",
  ]);

  if (!bodyPart || !issue) return null;

  if (context) {
    return `Recurring ${bodyPart} ${issue} during ${context}.`;
  }

  return `Recurring ${bodyPart} ${issue}.`;
}

function buildActivityContextCandidate(summary: string): string | null {
  const input = summary.trim().toLowerCase();
  if (!input) return null;

  const activity = extractFirstMatch(input, [
    "racquetball",
    "tennis",
    "golf",
    "baseball",
    "lifting",
    "running",
    "walking",
    "pickleball",
    "swinging",
  ]);

  if (!activity) return null;

  return `Recurring activity context: ${activity}.`;
}

export async function promoteTimelineToUserMemory(userId: string) {
  const recentTimeline = await db
    .select()
    .from(timelineEntries)
    .where(eq(timelineEntries.userId, userId))
    .orderBy(desc(timelineEntries.id))
    .limit(50);

  if (recentTimeline.length === 0) return;

  const recurringSignalCounts = new Map<string, number>();
  const activityContextCounts = new Map<string, number>();

  for (const row of recentTimeline) {
    if (row.type !== "signal") continue;

    const signalCandidate = buildRecurringSignalCandidate(row.summary);
    if (signalCandidate) {
      recurringSignalCounts.set(
        signalCandidate,
        (recurringSignalCounts.get(signalCandidate) ?? 0) + 1,
      );
    }

    const activityCandidate = buildActivityContextCandidate(row.summary);
    if (activityCandidate) {
      activityContextCounts.set(
        activityCandidate,
        (activityContextCounts.get(activityCandidate) ?? 0) + 1,
      );
    }
  }

  const recurringSignalPatterns = Array.from(recurringSignalCounts.entries())
    .filter(([, count]) => count >= 2)
    .map(([value]) => value);

  const stableActivityContexts = Array.from(activityContextCounts.entries())
    .filter(([, count]) => count >= 2)
    .map(([value]) => value);

  if (
    recurringSignalPatterns.length === 0 &&
    stableActivityContexts.length === 0
  ) {
    return;
  }

  const existing = await db
    .select()
    .from(userMemory)
    .where(eq(userMemory.userId, userId))
    .limit(1);

  const currentMemory =
    existing[0]?.memory && typeof existing[0].memory === "object"
      ? (existing[0].memory as Record<string, any>)
      : {};

  const promotedRecurringThemes = Array.from(
    new Set([...recurringSignalPatterns, ...stableActivityContexts]),
  );

  const nextMemory = {
    ...currentMemory,
    movementPatterns: {
      ...(currentMemory.movementPatterns ?? {
        confirmed: [],
        suspected: [],
        recurringThemes: [],
      }),
      recurringThemes: Array.from(
        new Set([
          ...(Array.isArray(currentMemory.movementPatterns?.recurringThemes)
            ? currentMemory.movementPatterns.recurringThemes
            : []),
          ...promotedRecurringThemes,
        ]),
      ),
    },
  };

  if (existing[0]) {
    await db
      .update(userMemory)
      .set({
        memory: nextMemory,
        updatedAt: new Date(),
      })
      .where(eq(userMemory.userId, userId));
  } else {
    await db.insert(userMemory).values({
      userId,
      memory: nextMemory,
    });
  }
}

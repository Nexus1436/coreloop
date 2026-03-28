import { db } from "../db.ts";
import { userMemory, timelineEntries, caseReviews } from "@shared/schema";
import { eq } from "drizzle-orm";

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
  summary: string;
  dominantSignal?: string;
  dominantMechanism?: string;
}) {
  if (!params.summary || params.summary.length < 20) return;

  await db.insert(timelineEntries).values({
    userId: params.userId,
    conversationId: params.conversationId,
    summary: params.summary,
    dominantSignal: params.dominantSignal ?? null,
    dominantMechanism: params.dominantMechanism ?? null,
    status: "active",
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
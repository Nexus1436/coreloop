import { db } from "../db";
import { userMemory } from "@shared/schema";
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
   MERGE EXTRACTED MEMORY
===================================================== */

export function mergeExtracted(memory: any, extracted: Record<string, any>) {
  for (const key of Object.keys(extracted)) {
    const value = extracted[key];

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

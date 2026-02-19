import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* =====================================================
   PATH SETUP
===================================================== */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEMORY_DIR = path.join(__dirname, "../data/memory");

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
   FILE HELPERS
===================================================== */

function getMemoryPath(sessionId: string): string {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }

  return path.join(MEMORY_DIR, `${sessionId}.json`);
}

/* =====================================================
   MEMORY LOADER (WITH AUTO-SCHEMA UPGRADE)
===================================================== */

export function getMemory(sessionId: string): InterloopMemory {
  const filePath = getMemoryPath(sessionId);

  if (!fs.existsSync(filePath)) {
    const memory = createDefaultMemory();
    fs.writeFileSync(filePath, JSON.stringify(memory, null, 2));
    return memory;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const existing = JSON.parse(raw);

  const defaultMemory = createDefaultMemory();

  // Deep merge to auto-upgrade old files
  const merged: InterloopMemory = {
    ...defaultMemory,
    ...existing,
    identity: { ...defaultMemory.identity, ...existing.identity },
    anthropometry: {
      ...defaultMemory.anthropometry,
      ...existing.anthropometry,
    },
    body: { ...defaultMemory.body, ...existing.body },
    sportContext: { ...defaultMemory.sportContext, ...existing.sportContext },
    movementPatterns: {
      ...defaultMemory.movementPatterns,
      ...existing.movementPatterns,
    },
    signalHistory: {
      ...defaultMemory.signalHistory,
      ...existing.signalHistory,
    },
    experiments: { ...defaultMemory.experiments, ...existing.experiments },
    performanceTrends: {
      ...defaultMemory.performanceTrends,
      ...existing.performanceTrends,
    },
    cognitivePatterns: {
      ...defaultMemory.cognitivePatterns,
      ...existing.cognitivePatterns,
    },
    sessionMeta: { ...defaultMemory.sessionMeta, ...existing.sessionMeta },
  };

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));

  return merged;
}

/* =====================================================
   MEMORY UPDATER
===================================================== */

export function updateMemory(
  sessionId: string,
  updater: (memory: InterloopMemory) => void,
): void {
  const memory = getMemory(sessionId);

  updater(memory);

  memory.sessionMeta.totalSessions += 1;
  memory.sessionMeta.lastSession = new Date().toISOString();

  const filePath = getMemoryPath(sessionId);
  fs.writeFileSync(filePath, JSON.stringify(memory, null, 2));
}

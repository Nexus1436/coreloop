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

function ensureMemoryDir(): void {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function getMemoryPath(sessionId: string): string {
  ensureMemoryDir();
  // keep filename stable + safe
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(MEMORY_DIR, `${safeId}.json`);
}

/* =====================================================
   SAFE JSON PARSER
===================================================== */

function safeParse<T = any>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/* =====================================================
   STRING NORMALIZATION + DEDUP
===================================================== */

function normalizeString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.,!?]+$/, "")
    .trim();
  return s ? s : null;
}

function uniqueStrings(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    const s = normalizeString(item);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }

  return out;
}

/* =====================================================
   INJURY DEDUP
===================================================== */

function dedupeInjuries(injuries: unknown): {
  location: string;
  severity: string;
  status: "active" | "historical";
}[] {
  if (!Array.isArray(injuries)) return [];

  const out: {
    location: string;
    severity: string;
    status: "active" | "historical";
  }[] = [];

  const seen = new Set<string>();

  for (const it of injuries) {
    if (!it || typeof it !== "object") continue;
    const obj = it as any;

    const location = normalizeString(obj.location);
    if (!location) continue;

    const severity = normalizeString(obj.severity) ?? "unknown";
    const status: "active" | "historical" =
      obj.status === "historical" ? "historical" : "active";

    const key = `${location.toLowerCase()}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ location, severity, status });
  }

  return out;
}

/* =====================================================
   MEMORY LOADER (AUTO SCHEMA UPGRADE)
===================================================== */

export function getMemory(sessionId: string): InterloopMemory {
  const filePath = getMemoryPath(sessionId);

  if (!fs.existsSync(filePath)) {
    const memory = createDefaultMemory();
    fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf-8");
    return memory;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const existing = safeParse<any>(raw) ?? {};

  const defaults = createDefaultMemory();

  const merged: InterloopMemory = {
    ...defaults,
    ...existing,

    identity: {
      ...defaults.identity,
      ...(existing.identity ?? {}),
    },

    anthropometry: {
      ...defaults.anthropometry,
      ...(existing.anthropometry ?? {}),
      notes: uniqueStrings(existing.anthropometry?.notes),
    },

    body: {
      ...defaults.body,
      ...(existing.body ?? {}),
      chronicTensionZones: uniqueStrings(existing.body?.chronicTensionZones),
      instabilityZones: uniqueStrings(existing.body?.instabilityZones),
      injuries: dedupeInjuries(existing.body?.injuries),
    },

    sportContext: {
      ...defaults.sportContext,
      ...(existing.sportContext ?? {}),
      secondarySports: uniqueStrings(existing.sportContext?.secondarySports),
    },

    movementPatterns: {
      ...defaults.movementPatterns,
      ...(existing.movementPatterns ?? {}),
      confirmed: uniqueStrings(existing.movementPatterns?.confirmed),
      suspected: uniqueStrings(existing.movementPatterns?.suspected),
      recurringThemes: uniqueStrings(
        existing.movementPatterns?.recurringThemes,
      ),
    },

    signalHistory: {
      ...defaults.signalHistory,
      ...(existing.signalHistory ?? {}),
      recurringPainSignals: uniqueStrings(
        existing.signalHistory?.recurringPainSignals,
      ),
      recurringConfusionSignals: uniqueStrings(
        existing.signalHistory?.recurringConfusionSignals,
      ),
      fearTriggers: uniqueStrings(existing.signalHistory?.fearTriggers),
    },

    experiments: {
      ...defaults.experiments,
      ...(existing.experiments ?? {}),
      successful: uniqueStrings(existing.experiments?.successful),
      failed: uniqueStrings(existing.experiments?.failed),
      neutral: uniqueStrings(existing.experiments?.neutral),
    },

    performanceTrends: {
      ...defaults.performanceTrends,
      ...(existing.performanceTrends ?? {}),
      improvements: uniqueStrings(existing.performanceTrends?.improvements),
      regressions: uniqueStrings(existing.performanceTrends?.regressions),
      consistencyNotes: uniqueStrings(
        existing.performanceTrends?.consistencyNotes,
      ),
    },

    cognitivePatterns: {
      ...defaults.cognitivePatterns,
      ...(existing.cognitivePatterns ?? {}),
      notes: uniqueStrings(existing.cognitivePatterns?.notes),
      overanalysis: Boolean(existing.cognitivePatterns?.overanalysis ?? false),
      rushTendency: Boolean(existing.cognitivePatterns?.rushTendency ?? false),
      hesitationPattern: Boolean(
        existing.cognitivePatterns?.hesitationPattern ?? false,
      ),
    },

    sessionMeta: {
      ...defaults.sessionMeta,
      ...(existing.sessionMeta ?? {}),
      totalSessions: Number.isFinite(existing.sessionMeta?.totalSessions)
        ? Number(existing.sessionMeta.totalSessions)
        : defaults.sessionMeta.totalSessions,
      lastSession:
        typeof existing.sessionMeta?.lastSession === "string"
          ? existing.sessionMeta.lastSession
          : defaults.sessionMeta.lastSession,
    },
  };

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
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

  // Re-normalize / dedupe after mutation
  memory.anthropometry.notes = uniqueStrings(memory.anthropometry.notes);

  memory.body.chronicTensionZones = uniqueStrings(
    memory.body.chronicTensionZones,
  );
  memory.body.instabilityZones = uniqueStrings(memory.body.instabilityZones);
  memory.body.injuries = dedupeInjuries(memory.body.injuries);

  memory.sportContext.secondarySports = uniqueStrings(
    memory.sportContext.secondarySports,
  );

  memory.movementPatterns.confirmed = uniqueStrings(
    memory.movementPatterns.confirmed,
  );
  memory.movementPatterns.suspected = uniqueStrings(
    memory.movementPatterns.suspected,
  );
  memory.movementPatterns.recurringThemes = uniqueStrings(
    memory.movementPatterns.recurringThemes,
  );

  memory.signalHistory.recurringPainSignals = uniqueStrings(
    memory.signalHistory.recurringPainSignals,
  );
  memory.signalHistory.recurringConfusionSignals = uniqueStrings(
    memory.signalHistory.recurringConfusionSignals,
  );
  memory.signalHistory.fearTriggers = uniqueStrings(
    memory.signalHistory.fearTriggers,
  );

  memory.experiments.successful = uniqueStrings(memory.experiments.successful);
  memory.experiments.failed = uniqueStrings(memory.experiments.failed);
  memory.experiments.neutral = uniqueStrings(memory.experiments.neutral);

  memory.performanceTrends.improvements = uniqueStrings(
    memory.performanceTrends.improvements,
  );
  memory.performanceTrends.regressions = uniqueStrings(
    memory.performanceTrends.regressions,
  );
  memory.performanceTrends.consistencyNotes = uniqueStrings(
    memory.performanceTrends.consistencyNotes,
  );

  memory.cognitivePatterns.notes = uniqueStrings(
    memory.cognitivePatterns.notes,
  );

  // Session meta (kept exactly as you had it)
  memory.sessionMeta.totalSessions += 1;
  memory.sessionMeta.lastSession = new Date().toISOString();

  const filePath = getMemoryPath(sessionId);
  fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf-8");
}

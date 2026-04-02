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

  patterns: {
    emerging: string[];
    active: string[];
    resolved: string[];
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
    notes: [];
  };

  sessionMeta: {
    totalSessions: number;
    lastSession: string | null;
  };
}

/* =====================================================
   DEFAULT MEMORY
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
    anthropometry: { limbLengthBias: null, notes: [] },
    body: { injuries: [], chronicTensionZones: [], instabilityZones: [] },
    sportContext: {
      primarySport: null,
      secondarySports: [],
      yearsExperience: null,
      competitionLevel: null,
    },
    movementPatterns: { confirmed: [], suspected: [], recurringThemes: [] },

    patterns: {
      emerging: [],
      active: [],
      resolved: [],
    },

    signalHistory: {
      recurringPainSignals: [],
      recurringConfusionSignals: [],
      fearTriggers: [],
    },
    experiments: { successful: [], failed: [], neutral: [] },
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
    sessionMeta: { totalSessions: 0, lastSession: null },
  };
}

/* =====================================================
   MEMORY LOAD
===================================================== */

export async function getMemory(userId: string): Promise<InterloopMemory> {
  const rows = await db
    .select()
    .from(userMemory)
    .where(eq(userMemory.userId, userId))
    .limit(1);

  if (rows.length === 0) {
    const memory = createDefaultMemory();
    await db.insert(userMemory).values({ userId, memory });
    return memory;
  }

  return { ...createDefaultMemory(), ...(rows[0].memory as InterloopMemory) };
}

/* =====================================================
   MEMORY UPDATE
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
   PROMPT BLOCK
===================================================== */

export function buildMemoryPromptBlock(memory: InterloopMemory): string {
  const lines: string[] = [];

  if (memory.identity.name) lines.push(`Name: ${memory.identity.name}`);

  if (memory.movementPatterns.recurringThemes.length > 0) {
    lines.push("Recurring themes:");
    memory.movementPatterns.recurringThemes
      .slice(0, 6)
      .forEach((t) => lines.push(`- ${t}`));
  }

  if (lines.length === 0) return "";

  return `=== USER MEMORY ===\n${lines.join("\n")}`;
}

/* =====================================================
   TIMELINE WRITER
===================================================== */

export async function writeTimelineEntry(params: {
  userId: string;
  conversationId: number;
  type?: "signal" | "adjustment" | "outcome";
  summary: string;
}) {
  if (!params.summary || params.summary.length < 20) return;

  await db.insert(timelineEntries).values({
    userId: params.userId,
    conversationId: params.conversationId,
    summary: params.summary,
    type: params.type ?? null,
  });
}

/* =====================================================
   CASE REVIEW
===================================================== */

export async function writeCaseReview(params: {
  userId: string;
  caseId: number;
  reviewText: string;
}) {
  if (!params.reviewText || params.reviewText.length < 40) return;

  const text = params.reviewText.toLowerCase();

  const mechanismMatch =
    text.match(/rotation|timing|sequencing|stability|mobility|tension/)?.[0] ??
    null;

  const constraintMatch =
    text.match(/tight|restricted|limited|stiff|unstable|collapsing/)?.[0] ??
    null;

  const leverMatch =
    text.match(/adjust|shift|focus|slow|relax|drive|load/)?.[0] ?? null;

  let outcomeDirection: "improving" | "stalled" | "regressing" = "stalled";

  if (/better|improved|easier|cleaner|more control/.test(text)) {
    outcomeDirection = "improving";
  } else if (/worse|pain|harder|tighter/.test(text)) {
    outcomeDirection = "regressing";
  }

  const structured = {
    mechanism: mechanismMatch,
    constraint: constraintMatch,
    lever: leverMatch,
    outcomeDirection,
  };

  await db.insert(caseReviews).values({
    userId: params.userId,
    caseId: params.caseId,
    reviewText: params.reviewText,
    structured,
  });
}
/* =====================================================
   FIXED PROMOTION LOGIC
===================================================== */

export async function promoteTimelineToUserMemory(userId: string) {
  const recentTimeline = await db
    .select()
    .from(timelineEntries)
    .where(eq(timelineEntries.userId, userId))
    .orderBy(desc(timelineEntries.id))
    .limit(50);

  if (recentTimeline.length === 0) return;

  // STEP 1: COLLECT ALL SUMMARIES
  const summaries: string[] = [];

  for (const row of recentTimeline) {
    if (!row.summary) continue;

    const normalized = row.summary
      .toLowerCase()
      .replace(/[.,!?]/g, "")
      .trim();

    summaries.push(normalized);
  }

  // STEP 2: LIGHT GROUPING
  const clusters: Record<string, string[]> = {};

  for (const summary of summaries) {
    let matchedKey: string | null = null;

    for (const key of Object.keys(clusters)) {
      const overlap = summary.split(" ").filter((w) => key.includes(w)).length;

      if (overlap >= 2) {
        matchedKey = key;
        break;
      }
    }

    if (matchedKey) {
      clusters[matchedKey].push(summary);
    } else {
      clusters[summary] = [summary];
    }
  }

  // STEP 3: BUILD THEMES FROM CLUSTERS
  const themes = Object.values(clusters).map((group) => group[0]);

  // STEP 4: BUILD PATTERNS
  const patternCounts = new Map<string, number>();

  for (const group of Object.values(clusters)) {
    const key = group[0];
    patternCounts.set(key, group.length);
  }

  const emerging: string[] = [];
  const active: string[] = [];

  for (const [pattern, count] of Array.from(patternCounts.entries())) {
    if (count >= 3) {
      active.push(pattern);
    } else if (count === 2) {
      emerging.push(pattern);
    }
  }

  // STEP 5: LOAD EXISTING MEMORY
  const existing = await db
    .select()
    .from(userMemory)
    .where(eq(userMemory.userId, userId))
    .limit(1);

  const current = (existing[0]?.memory ?? {}) as any;

  // STEP 6: MERGE INTO MEMORY
  const nextMemory = {
    ...current,
    movementPatterns: {
      ...(current.movementPatterns ?? {}),
      recurringThemes: Array.from(
        new Set([
          ...(current.movementPatterns?.recurringThemes ?? []),
          ...themes,
        ]),
      ),
    },
    patterns: {
      emerging: Array.from(
        new Set([...(current.patterns?.emerging ?? []), ...emerging]),
      ),
      active: Array.from(
        new Set([...(current.patterns?.active ?? []), ...active]),
      ),
      resolved: current.patterns?.resolved ?? [],
    },
  };

  // STEP 7: SAVE
  if (existing[0]) {
    await db
      .update(userMemory)
      .set({
        memory: nextMemory,
        updatedAt: new Date(),
      })
      .where(eq(userMemory.userId, userId));
  } else {
    await db.insert(userMemory).values({ userId, memory: nextMemory });
  }
}

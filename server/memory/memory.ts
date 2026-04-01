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

  await db.insert(caseReviews).values({
    userId: params.userId,
    caseId: params.caseId,
    reviewText: params.reviewText,
  });
}

/* =====================================================
   HELPERS
===================================================== */

function buildRecurringSignalCandidate(summary: string): string | null {
  const input = summary.toLowerCase();

  const body = input.match(/shoulder|back|neck|hip|knee|arm|core/)?.[0];
  const issue = input.match(/pain|tight|tightness|hurt|stiff/)?.[0];

  if (!body || !issue) return null;

  return `Recurring ${body} ${issue}`;
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

  const signalCounts = new Map<string, number>();

  for (const row of recentTimeline) {
    if (!row.summary) continue;

    const candidate = buildRecurringSignalCandidate(row.summary);
    if (candidate) {
      signalCounts.set(candidate, (signalCounts.get(candidate) ?? 0) + 1);
    }
  }

  const recurring = Array.from(signalCounts.entries())
    .filter(([, count]) => count >= 1)
    .map(([value]) => value);

  const fallback = recentTimeline.map((r) => r.summary).slice(0, 5);

  const themes = Array.from(new Set([...recurring, ...fallback]));

  const existing = await db
    .select()
    .from(userMemory)
    .where(eq(userMemory.userId, userId))
    .limit(1);

  const current = (existing[0]?.memory ?? {}) as any;

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
    await db.insert(userMemory).values({ userId, memory: nextMemory });
  }
}

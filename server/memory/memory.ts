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

  if (memory.identity.name) {
    lines.push(`Name: ${memory.identity.name}`);
  }

  if (memory.movementPatterns.recurringThemes.length > 0) {
    lines.push("Recurring themes:");
    memory.movementPatterns.recurringThemes
      .slice(0, 6)
      .forEach((t) => lines.push(`- ${t}`));
  }

  if (memory.patterns.active.length > 0) {
    lines.push("Active patterns:");
    memory.patterns.active.slice(0, 5).forEach((p) => lines.push(`- ${p}`));
  }

  if (memory.patterns.emerging.length > 0) {
    lines.push("Emerging patterns:");
    memory.patterns.emerging.slice(0, 5).forEach((p) => lines.push(`- ${p}`));
  }

  if (lines.length === 0) return "";

  return `=== USER MEMORY ===
Use this as durable cross-session truth.
Prefer continuity with active patterns when relevant.
Do not restart investigation if the current issue matches an active pattern.

${lines.join("\n")}`;
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
    .limit(80);

  const recentCaseReviews = await db
    .select()
    .from(caseReviews)
    .where(eq(caseReviews.userId, userId))
    .orderBy(desc(caseReviews.id))
    .limit(12);

  if (recentTimeline.length === 0 && recentCaseReviews.length === 0) return;

  const STOPWORDS = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "if",
    "then",
    "than",
    "that",
    "this",
    "these",
    "those",
    "with",
    "from",
    "into",
    "onto",
    "during",
    "while",
    "when",
    "where",
    "after",
    "before",
    "over",
    "under",
    "through",
    "about",
    "around",
    "just",
    "very",
    "really",
    "more",
    "less",
    "some",
    "still",
    "feel",
    "feels",
    "feeling",
    "have",
    "has",
    "had",
    "been",
    "being",
    "was",
    "were",
    "are",
    "is",
    "am",
    "to",
    "of",
    "in",
    "on",
    "for",
    "at",
    "by",
    "my",
    "your",
    "our",
    "their",
    "it",
    "its",
    "im",
    "i'm",
    "ive",
    "i've",
    "me",
    "we",
    "you",
    "they",
    "them",
    "do",
    "did",
    "does",
    "doing",
    "done",
    "get",
    "got",
    "getting",
    "make",
    "made",
    "making",
    "problem",
    "issue",
  ]);

  function normalizeText(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(input: string): string[] {
    return normalizeText(input)
      .split(" ")
      .map((w) => {
        if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
        if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
        if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
        if (w.endsWith("s") && w.length > 3) return w.slice(0, -1);
        return w;
      })
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  }

  function unique<T>(items: T[]): T[] {
    return Array.from(new Set(items));
  }

  function overlapScore(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const bSet = new Set(b);
    return a.filter((t) => bSet.has(t)).length;
  }

  function buildLabel(tokens: string[], fallback: string): string {
    if (tokens.length === 0) return fallback;
    return unique(tokens).slice(0, 6).join(" ");
  }

  type Evidence = {
    raw: string;
    normalized: string;
    tokens: string[];
    source: "timeline" | "case_review";
    weight: number;
  };

  const evidence: Evidence[] = [];

  for (const row of recentTimeline) {
    if (!row.summary) continue;

    const normalized = normalizeText(row.summary);
    const tokens = tokenize(row.summary);

    if (!normalized || tokens.length === 0) continue;

    evidence.push({
      raw: row.summary.trim(),
      normalized,
      tokens,
      source: "timeline",
      weight: 1,
    });
  }

  for (const review of recentCaseReviews) {
    const structured = (review.structured ?? {}) as any;

    const mechanism =
      typeof structured?.mechanism === "string" ? structured.mechanism : null;
    const constraint =
      typeof structured?.constraint === "string" ? structured.constraint : null;
    const lever =
      typeof structured?.lever === "string" ? structured.lever : null;
    const outcomeDirection =
      typeof structured?.outcomeDirection === "string"
        ? structured.outcomeDirection
        : null;

    const parts = [mechanism, constraint, lever].filter(Boolean) as string[];

    if (parts.length === 0) continue;

    const raw = `${parts.join(" ")}${outcomeDirection ? ` ${outcomeDirection}` : ""}`;
    const normalized = normalizeText(raw);
    const tokens = tokenize(raw);

    if (!normalized || tokens.length === 0) continue;

    evidence.push({
      raw,
      normalized,
      tokens,
      source: "case_review",
      weight: 2,
    });
  }

  if (evidence.length === 0) return;

  const clusters: {
    label: string;
    tokens: string[];
    examples: string[];
    score: number;
  }[] = [];

  for (const item of evidence) {
    let bestIndex = -1;
    let bestScore = 0;

    for (let i = 0; i < clusters.length; i++) {
      const score = overlapScore(item.tokens, clusters[i].tokens);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= 2) {
      const cluster = clusters[bestIndex];
      cluster.examples.push(item.raw);
      cluster.tokens = unique([...cluster.tokens, ...item.tokens]);
      cluster.score += item.weight;
    } else {
      clusters.push({
        label: buildLabel(item.tokens, item.normalized),
        tokens: [...item.tokens],
        examples: [item.raw],
        score: item.weight,
      });
    }
  }

  const rankedClusters = clusters
    .map((cluster) => ({
      label: buildLabel(cluster.tokens, cluster.label),
      examples: unique(cluster.examples),
      score: cluster.score,
    }))
    .sort((a, b) => b.score - a.score);

  const themes = rankedClusters.slice(0, 10).map((cluster) => cluster.label);

  const emerging: string[] = [];
  const active: string[] = [];

  for (const cluster of rankedClusters) {
    if (cluster.score >= 4) {
      active.push(cluster.label);
    } else if (cluster.score >= 2) {
      emerging.push(cluster.label);
    }
  }

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
      ).slice(0, 20),
    },
    patterns: {
      emerging: Array.from(
        new Set([...(current.patterns?.emerging ?? []), ...emerging]),
      )
        .filter((p) => !active.includes(p))
        .slice(0, 12),
      active: Array.from(
        new Set([...(current.patterns?.active ?? []), ...active]),
      ).slice(0, 12),
      resolved: current.patterns?.resolved ?? [],
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

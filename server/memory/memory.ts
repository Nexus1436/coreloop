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

function isValidMemoryCandidate(text: string): boolean {
  const t = String(text ?? "").trim();

  if (!t) return false;

  if (t.length < 20) return false;

  if (/\b(thi|giv|dropp|figur|someth|alway|recurr|hav)\b/i.test(t))
    return false;

  const words = t.split(/\s+/);
  const shortWords = words.filter((w) => w.length <= 3).length;
  if (words.length > 0 && shortWords / words.length > 0.6) return false;

  if (!/[a-z]{3,}\s+[a-z]{3,}/i.test(t)) return false;

  return true;
}

function normalizeMemoryCandidate(
  text: string | null | undefined,
): string | null {
  const t = String(text ?? "").trim();

  if (!t) return null;

  let cleaned = t.replace(/\s+/g, " ").replace(/^\W+|\W+$/g, "");

  if (!cleaned) return null;

  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

  if (!/[.!?]$/.test(cleaned)) {
    cleaned += ".";
  }

  return cleaned;
}

function buildMemoryStatementFromExamples(examples: string[]): string | null {
  const cleanedExamples = examples
    .map((example) =>
      String(example ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);

  if (cleanedExamples.length === 0) return null;

  const fillerPattern =
    /\b(thank you|thanks|that helped|this helped|great|okay|ok|yes|yep|yeah|got it|perfect|awesome|sounds good|i(?:'|’)ll let you know|let you know|makes sense)\b/i;

  const symptomPattern =
    /\b(pain|tightness|tight|tension|strain|strained|stiffness|stiff|discomfort|irritation|irritated|aggravated|soreness|sore|catching|pinching|pulling|tugging|instability|unstable|weakness|weak)\b/i;

  const mechanismPattern =
    /\b(may|might|likely|due to|caused by|comes from|coming from|driven by|related to|linked to|because)\b/i;

  const resultPattern =
    /\b(helped|improved|better|easier|worse|aggravated|relieved|reduced|less)\b/i;

  const bodyPattern =
    /\b(right|left|rear|front)?\s*(shoulder|neck|low back|lower back|mid back|upper back|back|trapezius|trap|rear deltoid|deltoid|hip|knee|ankle|elbow|wrist|foot|feet|hamstring|quad|glute|glutes|arm)\b/i;

  const contextPattern =
    /\b(during|while|when|with|after|before|on|in)\s+([^.!?]{3,80})/i;

  const adjustmentPattern =
    /\b(letting|focusing on|shifting|adjusting|slowing|relaxing|driving|loading|rotating|keeping|allowing)\b[^.!?]{4,100}/i;

  function cleanStatementEnding(text: string): string {
    let value = text.replace(/\s+/g, " ").trim();
    if (!value) return "";

    const sentenceMatch = value.match(/^(.+?[.!?])(?:\s|$)/);
    if (sentenceMatch?.[1]) {
      value = sentenceMatch[1].trim();
    } else {
      const boundaryPatterns = [
        /\b(?:and|but|so|because)\s+i\b/i,
        /\b(?:and|but|so)\s+it\b/i,
        /\bi\s+have\b/i,
        /\bi\s+was\b/i,
        /\bi\s+am\b/i,
        /\bi'm\b/i,
      ];

      let cutoff = value.length;

      for (const pattern of boundaryPatterns) {
        const match = pattern.exec(value);
        if (match && match.index > 20) {
          cutoff = Math.min(cutoff, match.index);
        }
      }

      if (cutoff < value.length) {
        value = value.slice(0, cutoff).trim();
      }

      const punctuationCutoff = Math.max(
        value.lastIndexOf(","),
        value.lastIndexOf(";"),
      );

      if (punctuationCutoff > 20) {
        value = value.slice(0, punctuationCutoff).trim();
      }

      value = value
        .replace(
          /\b(?:and|but|so|because|when|while|with|during|after|before|on|in)$/i,
          "",
        )
        .trim();

      if (!/[.!?]$/.test(value)) {
        value += ".";
      }
    }

    return value.trim();
  }

  function normalizeSymptomPhrase(text: string): string {
    return text
      .replace(/\btight\b/gi, "tightness")
      .replace(/\bstiff\b/gi, "stiffness")
      .replace(/\bweak\b/gi, "weakness")
      .replace(/\bunstable\b/gi, "instability")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractDurableContext(text: string): string | null {
    const match = text.match(contextPattern);
    if (!match) return null;

    const candidate = `${match[1].toLowerCase()} ${match[2].trim()}`
      .replace(/\s+/g, " ")
      .trim();

    if (!candidate) return null;

    const weakContextPattern =
      /\bwhen\s+(?:we|i)\s+(?:started all this|start(?:ed)? this all|started this|told you earlier|were talking about|talked about|brought this up)\b|\bwhen\s+this all\s+(?:started|began)\b|\bwhen\s+that happened earlier\b/i;

    const strongContextPattern =
      /\b(backhand|forehand|serve|serving|swing|swinging|rotation|rotating|twisting|lifting|running|walking|standing|sitting|computer|desk|work|working|driving|training|practice|practicing|throwing|repeated|fatigue|under load|at speed|setup|contact point)\b/i;

    if (weakContextPattern.test(candidate)) return null;
    if (!strongContextPattern.test(candidate)) return null;

    return candidate;
  }

  function scoreExample(example: string): number {
    const lower = example.toLowerCase();
    let score = 0;

    if (/[.!?]$/.test(example)) score += 4;
    if (symptomPattern.test(example)) score += 4;
    if (bodyPattern.test(example)) score += 3;
    if (contextPattern.test(example)) score += 3;
    if (adjustmentPattern.test(example) && resultPattern.test(example))
      score += 4;
    if (mechanismPattern.test(example)) score += 2;
    if (lower.length >= 35) score += 2;
    if (lower.length <= 180) score += 1;
    if (/\b(i have two|i have|i'm|i am|and i|but i|so i)\b/i.test(lower))
      score -= 3;
    if (fillerPattern.test(example)) score -= 6;

    return score;
  }

  const usableExamples = cleanedExamples.filter((example) => {
    if (
      fillerPattern.test(example) &&
      !symptomPattern.test(example) &&
      !mechanismPattern.test(example) &&
      !resultPattern.test(example)
    ) {
      return false;
    }

    return true;
  });

  const rankedExamples = [...usableExamples].sort(
    (a, b) => scoreExample(b) - scoreExample(a),
  );

  for (const example of rankedExamples) {
    const normalized = example.replace(/^\W+|\W+$/g, "");
    if (!normalized) continue;

    const bodyMatch = normalized.match(bodyPattern);
    const symptomMatch = normalized.match(symptomPattern);
    const adjustmentMatch = normalized.match(adjustmentPattern);

    if (adjustmentMatch && resultPattern.test(normalized)) {
      const clause = adjustmentMatch[0]
        .replace(/\bmy\b/gi, "the")
        .replace(/\byour\b/gi, "the")
        .replace(/\s+/g, " ")
        .trim();

      const outcome = /\bworse|aggravated\b/i.test(normalized)
        ? "made the movement worse"
        : /\b(helped|improved|better|easier|relieved|reduced|less)\b/i.test(
              normalized,
            )
          ? "improved the movement"
          : null;

      if (clause && outcome) {
        return cleanStatementEnding(
          `${clause.charAt(0).toUpperCase() + clause.slice(1)} ${outcome}`,
        );
      }
    }

    if (bodyMatch && symptomMatch) {
      const body = bodyMatch[0]
        .replace(/\btrap\b/i, "trapezius")
        .replace(/\s+/g, " ")
        .trim();

      const symptom = normalizeSymptomPhrase(symptomMatch[0].toLowerCase());
      const context = extractDurableContext(normalized);

      return cleanStatementEnding(
        context
          ? `${body.charAt(0).toUpperCase() + body.slice(1)} ${symptom} shows up ${context}`
          : `${body.charAt(0).toUpperCase() + body.slice(1)} ${symptom} shows up`,
      );
    }

    if (mechanismPattern.test(normalized) && !fillerPattern.test(normalized)) {
      return cleanStatementEnding(normalized);
    }
  }

  return null;
}

function pushReadableStatement(target: string[], candidate: string | null) {
  const normalized = normalizeMemoryCandidate(candidate);
  if (normalized && isValidMemoryCandidate(normalized)) {
    target.push(normalized);
  }
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const item of items) {
    const normalized = item.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(item.trim());
  }

  return out;
}

function normalizeBodyRegion(text: string): string | null {
  const input = String(text ?? "").toLowerCase();

  const patterns: Array<[RegExp, string]> = [
    [/\blow(?:er)? back\b|\blumbar\b/, "lower back"],
    [/\bmid(?:dle)? back\b|\bthoracic\b/, "mid back"],
    [/\bupper back\b/, "upper back"],
    [/\brear deltoid\b/, "rear deltoid"],
    [/\bdeltoid\b/, "shoulder"],
    [/\bshoulder\b/, "shoulder"],
    [/\bneck\b|\bcervical\b/, "neck"],
    [/\bhip\b|\bglute(?:s)?\b/, "hip"],
    [/\bknee\b/, "knee"],
    [/\bankle\b/, "ankle"],
    [/\belbow\b/, "elbow"],
    [/\bwrist\b/, "wrist"],
    [/\bhamstring\b/, "hamstring"],
    [/\bquad\b/, "quad"],
    [/\bfoot\b|\bfeet\b/, "foot"],
    [/\barm\b/, "arm"],
    [/\bback\b/, "back"],
  ];

  for (const [pattern, label] of patterns) {
    if (pattern.test(input)) return label;
  }

  return null;
}

function extractTextSources(
  recentTimeline: Array<{ summary: string | null }>,
  recentCaseReviews: Array<{ reviewText?: string | null; structured?: any }>,
): string[] {
  const sources: string[] = [];

  for (const row of recentTimeline) {
    if (row.summary?.trim()) sources.push(row.summary.trim());
  }

  for (const review of recentCaseReviews) {
    if (review.reviewText?.trim()) sources.push(review.reviewText.trim());

    const structured = (review.structured ?? {}) as any;
    const structuredText = [
      typeof structured?.mechanism === "string" ? structured.mechanism : null,
      typeof structured?.constraint === "string" ? structured.constraint : null,
      typeof structured?.lever === "string" ? structured.lever : null,
      typeof structured?.outcomeDirection === "string"
        ? structured.outcomeDirection
        : null,
    ]
      .filter(Boolean)
      .join(" ");

    if (structuredText.trim()) sources.push(structuredText.trim());
  }

  return sources;
}

function buildContextualSignalStatement(text: string): string | null {
  return buildMemoryStatementFromExamples([text]);
}

function extractMechanismStatement(
  text: string,
): {
  statement: string;
  bucket: "confirmed" | "suspected" | "resolved";
} | null {
  const input = String(text ?? "").trim();
  if (!input) return null;

  const mechanismLine = buildMemoryStatementFromExamples([input]);
  if (!mechanismLine) return null;

  if (
    /\b(resolved|went away|no longer|stopped showing up|fixed)\b/i.test(input)
  ) {
    return { statement: mechanismLine, bucket: "resolved" };
  }

  if (/\b(may|might|likely|seems|appears to|could be)\b/i.test(input)) {
    return { statement: mechanismLine, bucket: "suspected" };
  }

  if (
    /\b(due to|caused by|comes from|coming from|driven by|linked to|related to|because)\b/i.test(
      input,
    )
  ) {
    return { statement: mechanismLine, bucket: "confirmed" };
  }

  return null;
}

function extractExperimentStatement(
  text: string,
): { bucket: "successful" | "failed" | "neutral"; statement: string } | null {
  const input = String(text ?? "").trim();
  if (!input) return null;

  if (
    !/\b(letting|focusing on|shifting|adjusting|slowing|relaxing|driving|loading|rotating|keeping|allowing|changed|tried|started)\b/i.test(
      input,
    )
  ) {
    return null;
  }

  const statement = buildMemoryStatementFromExamples([input]);
  if (!statement) return null;

  if (/\b(no change|same|didn'?t help|unchanged|neutral)\b/i.test(input)) {
    return { bucket: "neutral", statement };
  }

  if (
    /\b(worse|aggravated|hurt more|pain increased|made it worse)\b/i.test(input)
  ) {
    return { bucket: "failed", statement };
  }

  if (
    /\b(helped|improved|better|easier|relieved|reduced|less)\b/i.test(input)
  ) {
    return { bucket: "successful", statement };
  }

  return null;
}

function extractPerformanceStatement(
  text: string,
): {
  bucket: "improvements" | "regressions" | "consistencyNotes";
  statement: string;
} | null {
  const input = String(text ?? "").trim();
  if (!input) return null;

  const cleaned = normalizeMemoryCandidate(input);
  if (!cleaned) return null;

  if (
    /\b(improved|better|cleaner|smoother|more control|timing has improved)\b/i.test(
      input,
    )
  ) {
    return { bucket: "improvements", statement: cleaned };
  }

  if (
    /\b(regresses|worse|breaks down|falls apart|under fatigue|at speed)\b/i.test(
      input,
    )
  ) {
    return { bucket: "regressions", statement: cleaned };
  }

  if (
    /\b(inconsistent|inconsistency|sometimes|variable|not consistent)\b/i.test(
      input,
    )
  ) {
    return { bucket: "consistencyNotes", statement: cleaned };
  }

  return null;
}

function normalizeCompetitionLevel(text: string): string | null {
  const input = String(text ?? "").toLowerCase();
  if (/\brecreational|rec league\b/.test(input)) return "recreational";
  if (/\bcompetitive|compete|tournament|tournaments\b/.test(input))
    return "competitive";
  if (/\bclub\b/.test(input)) return "club";
  if (/\bhigh school|varsity\b/.test(input)) return "high school";
  if (/\bcollege|collegiate\b/.test(input)) return "college";
  if (/\bprofessional|pro\b/.test(input)) return "professional";
  return null;
}

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

  function pushIfValid(target: string[], candidate: string) {
    const normalized = normalizeMemoryCandidate(candidate);

    if (normalized && isValidMemoryCandidate(normalized)) {
      target.push(normalized);
    }
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

    if (bestIndex >= 0 && bestScore >= 1) {
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

  const themes: string[] = [];
  const emerging: string[] = [];
  const active: string[] = [];
  const resolvedPatterns: string[] = [];
  const confirmedPatterns: string[] = [];
  const suspectedPatterns: string[] = [];

  for (const cluster of rankedClusters.slice(0, 10)) {
    const memoryStatement = buildMemoryStatementFromExamples(cluster.examples);
    if (memoryStatement) {
      pushIfValid(themes, memoryStatement);
    }
  }

  for (const cluster of rankedClusters) {
    const memoryStatement = buildMemoryStatementFromExamples(cluster.examples);
    if (!memoryStatement) continue;

    if (cluster.score >= 3) {
      pushIfValid(active, memoryStatement);
    } else if (cluster.score >= 1) {
      pushIfValid(emerging, memoryStatement);
    }
  }

  const sourceTexts = extractTextSources(
    recentTimeline,
    recentCaseReviews as any,
  );

  const existing = await db
    .select()
    .from(userMemory)
    .where(eq(userMemory.userId, userId))
    .limit(1);

  const current = {
    ...createDefaultMemory(),
    ...((existing[0]?.memory ?? {}) as any),
  } as InterloopMemory;

  const identity = { ...current.identity };
  const sportContext = {
    ...current.sportContext,
    secondarySports: [...(current.sportContext.secondarySports ?? [])],
  };
  const anthropometry = {
    ...current.anthropometry,
    notes: [...(current.anthropometry.notes ?? [])],
  };
  const body = {
    injuries: [...(current.body.injuries ?? [])],
    chronicTensionZones: [...(current.body.chronicTensionZones ?? [])],
    instabilityZones: [...(current.body.instabilityZones ?? [])],
  };
  const signalHistory = {
    recurringPainSignals: [
      ...(current.signalHistory.recurringPainSignals ?? []),
    ],
    recurringConfusionSignals: [
      ...(current.signalHistory.recurringConfusionSignals ?? []),
    ],
    fearTriggers: [...(current.signalHistory.fearTriggers ?? [])],
  };
  const experiments = {
    successful: [...(current.experiments.successful ?? [])],
    failed: [...(current.experiments.failed ?? [])],
    neutral: [...(current.experiments.neutral ?? [])],
  };
  const performanceTrends = {
    improvements: [...(current.performanceTrends.improvements ?? [])],
    regressions: [...(current.performanceTrends.regressions ?? [])],
    consistencyNotes: [...(current.performanceTrends.consistencyNotes ?? [])],
  };
  const cognitivePatterns = {
    overanalysis: Boolean(current.cognitivePatterns.overanalysis),
    rushTendency: Boolean(current.cognitivePatterns.rushTendency),
    hesitationPattern: Boolean(current.cognitivePatterns.hesitationPattern),
    notes: [...((current.cognitivePatterns.notes ?? []) as string[])],
  };

  const namedSports = [
    "racquetball",
    "volleyball",
    "tennis",
    "golf",
    "running",
    "lifting",
    "baseball",
    "pickleball",
    "basketball",
  ];

  let overanalysisCount = 0;
  let rushCount = 0;
  let hesitationCount = 0;

  for (const text of sourceTexts) {
    if (!identity.name) {
      const match = text.match(
        /\b(?:my name is|call me|i am|i'm)\s+([A-Z][a-z]{1,20})\b/,
      );
      if (match?.[1]) identity.name = match[1];
    }

    if (identity.age == null) {
      const match = text.match(
        /\b(?:i am|i'm)\s+(\d{1,2})\b|\b(\d{1,2})\s*(?:years?\s*old|yo)\b/i,
      );
      const age = Number(match?.[1] ?? match?.[2]);
      if (Number.isFinite(age) && age > 0) identity.age = age;
    }

    if (!identity.height) {
      const match = text.match(
        /\b(\d\s*'\s*\d{1,2}(?:\"|”)?|\d\s*(?:ft|feet)\s*\d{1,2}|\d{2,3}\s*cm|1\.\d{1,2}\s*m)\b/i,
      );
      if (match?.[1]) identity.height = match[1].replace(/\s+/g, " ").trim();
    }

    if (!identity.weight) {
      const match = text.match(/\b(\d{2,3}\s*(?:lb|lbs|pounds|kg|kgs))\b/i);
      if (match?.[1]) identity.weight = match[1].replace(/\s+/g, " ").trim();
    }

    if (!identity.dominantHand) {
      if (/\bright[-\s]?handed\b/i.test(text)) identity.dominantHand = "right";
      if (/\bleft[-\s]?handed\b/i.test(text)) identity.dominantHand = "left";
    }

    if (!sportContext.primarySport) {
      for (const sport of namedSports) {
        if (
          new RegExp(`\\b${sport}\\b`, "i").test(text) &&
          /\b(main|primary|mostly|mainly|primarily)\b/i.test(text)
        ) {
          sportContext.primarySport = sport;
          break;
        }
      }
    }

    const mentionedSports = namedSports.filter((sport) =>
      new RegExp(`\\b${sport}\\b`, "i").test(text),
    );

    if (!sportContext.primarySport && mentionedSports.length > 0) {
      sportContext.primarySport = mentionedSports[0];
    }

    for (const sport of mentionedSports) {
      if (sport !== sportContext.primarySport) {
        sportContext.secondarySports.push(sport);
      }
    }

    if (sportContext.yearsExperience == null) {
      const match = text.match(
        /\b(?:for|playing for|played for|training for)\s+(\d{1,2})\s+years?\b/i,
      );
      const years = Number(match?.[1]);
      if (Number.isFinite(years) && years > 0) {
        sportContext.yearsExperience = years;
      }
    }

    if (!sportContext.competitionLevel) {
      const level = normalizeCompetitionLevel(text);
      if (level) sportContext.competitionLevel = level;
    }

    if (!anthropometry.limbLengthBias) {
      const match = text.match(
        /\b(long femurs|short femurs|long arms|short arms|long torso|short torso)\b/i,
      );
      if (match?.[1]) anthropometry.limbLengthBias = match[1].toLowerCase();
    }

    if (
      /\b(knock-kneed|long femurs|short torso|long arms|hyperextends knees|bow-legged)\b/i.test(
        text,
      )
    ) {
      const structureNote = normalizeMemoryCandidate(
        text
          .replace(
            /^.*?\b(knock-kneed|long femurs|short torso|long arms|hyperextends knees|bow-legged)\b/i,
            "$1",
          )
          .replace(/\s+/g, " ")
          .trim() + " affects movement mechanics",
      );
      if (structureNote && isValidMemoryCandidate(structureNote)) {
        anthropometry.notes.push(structureNote);
      }
    }

    const region = normalizeBodyRegion(text);
    if (region) {
      if (/\b(tight|tightness|stiff|stiffness|tension)\b/i.test(text)) {
        body.chronicTensionZones.push(region);
      }

      if (
        /\b(unstable|instability|giving out|wobbly|not stable)\b/i.test(text)
      ) {
        body.instabilityZones.push(region);
      }

      if (
        /\b(pain|strain|strained|injury|injured|tear|tweak|sprain|aggravated|soreness|irritation)\b/i.test(
          text,
        )
      ) {
        const severityMatch = text.match(
          /\b(mild|moderate|severe|chronic|acute)\b/i,
        );
        const status =
          /\b(history of|used to|previously|years ago|last year|old injury|in the past)\b/i.test(
            text,
          )
            ? "historical"
            : "active";

        body.injuries.push({
          location: region,
          severity: severityMatch?.[1]?.toLowerCase() ?? "unspecified",
          status,
        });
      }
    }

    if (
      /\b(pain|tightness|stiffness|strain|soreness|irritation)\b/i.test(text)
    ) {
      pushReadableStatement(
        signalHistory.recurringPainSignals,
        buildContextualSignalStatement(text),
      );
    }

    if (
      /\b(confused|unclear|not sure|can't tell|cannot tell|can't figure out|hard to tell|don't know what's happening)\b/i.test(
        text,
      )
    ) {
      pushReadableStatement(
        signalHistory.recurringConfusionSignals,
        normalizeMemoryCandidate(text),
      );
    }

    if (
      /\b(hesitant|hesitation|afraid|fear|avoid|avoiding|reluctant|don't trust|do not trust|holding back)\b/i.test(
        text,
      )
    ) {
      pushReadableStatement(
        signalHistory.fearTriggers,
        normalizeMemoryCandidate(text),
      );
    }

    const experiment = extractExperimentStatement(text);
    if (experiment) {
      pushReadableStatement(
        experiments[experiment.bucket],
        experiment.statement,
      );
    }

    const performance = extractPerformanceStatement(text);
    if (performance) {
      pushReadableStatement(
        performanceTrends[performance.bucket],
        performance.statement,
      );
    }

    const mechanism = extractMechanismStatement(text);
    if (mechanism) {
      if (mechanism.bucket === "confirmed") {
        pushReadableStatement(confirmedPatterns, mechanism.statement);
      } else if (mechanism.bucket === "suspected") {
        pushReadableStatement(suspectedPatterns, mechanism.statement);
      } else if (mechanism.bucket === "resolved") {
        pushReadableStatement(resolvedPatterns, mechanism.statement);
      }
    }

    if (
      /\b(overthink|overthinking|second-guess|too much in my head|analyzing too much)\b/i.test(
        text,
      )
    ) {
      overanalysisCount += 1;
      pushReadableStatement(
        cognitivePatterns.notes,
        "Overthinking shows up during movement decisions.",
      );
    }

    if (/\b(rush|rushing|too fast|hurry|skip the setup)\b/i.test(text)) {
      rushCount += 1;
      pushReadableStatement(
        cognitivePatterns.notes,
        "Rushing the setup affects movement quality.",
      );
    }

    if (
      /\b(hesitant|hesitation|afraid|fear|holding back|reluctant)\b/i.test(text)
    ) {
      hesitationCount += 1;
      pushReadableStatement(
        cognitivePatterns.notes,
        "Hesitation shows up during execution.",
      );
    }
  }

  cognitivePatterns.overanalysis =
    cognitivePatterns.overanalysis || overanalysisCount >= 2;
  cognitivePatterns.rushTendency =
    cognitivePatterns.rushTendency || rushCount >= 2;
  cognitivePatterns.hesitationPattern =
    cognitivePatterns.hesitationPattern || hesitationCount >= 2;

  const nextMemory = {
    ...current,
    identity,
    anthropometry: {
      limbLengthBias: anthropometry.limbLengthBias,
      notes: uniqueStrings(anthropometry.notes),
    },
    body: {
      injuries: body.injuries.filter(
        (injury, index, arr) =>
          arr.findIndex(
            (other) =>
              other.location === injury.location &&
              other.severity === injury.severity &&
              other.status === injury.status,
          ) === index,
      ),
      chronicTensionZones: uniqueStrings(body.chronicTensionZones),
      instabilityZones: uniqueStrings(body.instabilityZones),
    },
    sportContext: {
      primarySport: sportContext.primarySport,
      secondarySports: uniqueStrings(
        sportContext.secondarySports.filter(
          (sport) => sport !== sportContext.primarySport,
        ),
      ),
      yearsExperience: sportContext.yearsExperience,
      competitionLevel: sportContext.competitionLevel,
    },
    movementPatterns: {
      ...(current.movementPatterns ?? {}),
      recurringThemes: Array.from(
        new Set([
          ...(current.movementPatterns?.recurringThemes ?? []),
          ...themes.filter((theme) => !active.includes(theme)),
        ]),
      ).slice(0, 20),
      confirmed: uniqueStrings([
        ...(current.movementPatterns?.confirmed ?? []),
        ...confirmedPatterns,
      ]).slice(0, 12),
      suspected: uniqueStrings([
        ...(current.movementPatterns?.suspected ?? []),
        ...suspectedPatterns,
      ]).slice(0, 12),
    },
    patterns: {
      emerging: uniqueStrings([
        ...(current.patterns?.emerging ?? []),
        ...emerging,
      ])
        .filter((p) => !active.includes(p))
        .slice(0, 12),
      active: uniqueStrings([
        ...(current.patterns?.active ?? []),
        ...active,
      ]).slice(0, 12),
      resolved: uniqueStrings([
        ...(current.patterns?.resolved ?? []),
        ...resolvedPatterns,
      ]).slice(0, 12),
    },
    signalHistory: {
      recurringPainSignals: uniqueStrings(
        signalHistory.recurringPainSignals,
      ).slice(0, 12),
      recurringConfusionSignals: uniqueStrings(
        signalHistory.recurringConfusionSignals,
      ).slice(0, 12),
      fearTriggers: uniqueStrings(signalHistory.fearTriggers).slice(0, 12),
    },
    experiments: {
      successful: uniqueStrings(experiments.successful).slice(0, 12),
      failed: uniqueStrings(experiments.failed).slice(0, 12),
      neutral: uniqueStrings(experiments.neutral).slice(0, 12),
    },
    performanceTrends: {
      improvements: uniqueStrings(performanceTrends.improvements).slice(0, 12),
      regressions: uniqueStrings(performanceTrends.regressions).slice(0, 12),
      consistencyNotes: uniqueStrings(performanceTrends.consistencyNotes).slice(
        0,
        12,
      ),
    },
    cognitivePatterns: {
      overanalysis: cognitivePatterns.overanalysis,
      rushTendency: cognitivePatterns.rushTendency,
      hesitationPattern: cognitivePatterns.hesitationPattern,
      notes: uniqueStrings(cognitivePatterns.notes).slice(0, 12),
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

export async function rebuildAllUserMemory(): Promise<void> {
  const rows = await db.select({ userId: userMemory.userId }).from(userMemory);

  for (const row of rows) {
    const userId = row.userId;

    await db
      .update(userMemory)
      .set({
        memory: createDefaultMemory(),
        updatedAt: new Date(),
      })
      .where(eq(userMemory.userId, userId));

    await promoteTimelineToUserMemory(userId);
  }
}

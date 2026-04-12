import { eq, asc, desc } from "drizzle-orm";

import { db } from "../db";
import {
  timelineEntries,
  cases,
  caseAdjustments,
  caseOutcomes,
  userMemory,
} from "@shared/schema";

type Primitive = string | number | boolean | null | undefined;

function cleanText(value: Primitive, max = 220): string | null {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

function uniqueCompact(values: Array<Primitive>, limit = 8): string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const value of values) {
    const cleaned = cleanText(value);
    if (!cleaned) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    output.push(cleaned);

    if (output.length >= limit) break;
  }

  return output;
}

function isProblemSignal(value: Primitive): boolean {
  return /\b(pain|problem|issue|struggle|can't|cannot|tight|confused|off|awkward|unstable|stiff|hurt|discomfort)\b/i.test(
    String(value ?? ""),
  );
}

function isNegativeText(value: Primitive): boolean {
  return /\b(worse|again|still|not working|regress|regression|back|pain|issue|failed|failure|no change|unchanged|aggravated|harder)\b/i.test(
    String(value ?? ""),
  );
}

function isPositiveText(value: Primitive): boolean {
  return /\b(improved|resolved|better|fixed|worked|helped|easier|clearer|smoother|less pain|less tight|more control)\b/i.test(
    String(value ?? ""),
  );
}

function summarizeAdjustment(
  cue: Primitive,
  focus: Primitive,
  outcome?: Primitive,
): string | null {
  const parts = [cleanText(cue, 140), cleanText(focus, 140)].filter(
    Boolean,
  ) as string[];

  if (parts.length === 0) return null;

  const base = uniqueCompact(parts, 2).join(" — ");
  const outcomeText = cleanText(outcome, 120);

  return outcomeText ? `${base} -> ${outcomeText}` : base;
}

function summarizeOutcome(
  result: Primitive,
  feedback: Primitive,
): string | null {
  const resultText = cleanText(result, 80);
  const feedbackText = cleanText(feedback, 180);

  if (resultText && feedbackText) return `${resultText}: ${feedbackText}`;
  return resultText ?? feedbackText;
}

function collectMemorySections(memory: any): {
  dominantPatterns: string[];
  recurringPatterns: string[];
  cognitivePatterns: string[];
  performanceTrends: string[];
  resolvedPatterns: string[];
  currentState: string[];
} {
  const dominantPatterns = uniqueCompact(
    [
      ...(memory?.patterns?.active ?? []),
      ...(memory?.patterns?.emerging ?? []),
      ...(memory?.movementPatterns?.confirmed ?? []),
      ...(memory?.movementPatterns?.suspected ?? []),
    ],
    8,
  );

  const recurringPatterns = uniqueCompact(
    [
      ...(memory?.movementPatterns?.recurringThemes ?? []),
      ...(memory?.signalHistory?.recurringPainSignals ?? []),
      ...(memory?.signalHistory?.recurringConfusionSignals ?? []),
      ...dominantPatterns,
    ],
    8,
  );

  const cognitiveNotes = [...(memory?.cognitivePatterns?.notes ?? [])];
  if (memory?.cognitivePatterns?.overanalysis) {
    cognitiveNotes.push("Overanalysis shows up repeatedly.");
  }
  if (memory?.cognitivePatterns?.rushTendency) {
    cognitiveNotes.push("A rush tendency shows up under load.");
  }
  if (memory?.cognitivePatterns?.hesitationPattern) {
    cognitiveNotes.push("Hesitation appears in execution.");
  }

  const cognitivePatterns = uniqueCompact(
    [...cognitiveNotes, ...(memory?.signalHistory?.fearTriggers ?? [])],
    6,
  );

  const performanceTrends = uniqueCompact(
    [
      ...(memory?.performanceTrends?.improvements ?? []),
      ...(memory?.performanceTrends?.regressions ?? []),
      ...(memory?.performanceTrends?.consistencyNotes ?? []),
    ],
    8,
  );

  const resolvedPatterns = uniqueCompact(
    [
      ...(memory?.patterns?.resolved ?? []),
      ...(memory?.experiments?.successful ?? []),
    ],
    6,
  );

  const currentState = uniqueCompact(
    [
      ...(memory?.patterns?.active ?? []),
      ...(memory?.movementPatterns?.recurringThemes ?? []),
      ...(memory?.body?.chronicTensionZones ?? []),
      ...(memory?.body?.instabilityZones ?? []),
      ...(memory?.signalHistory?.recurringPainSignals ?? []),
      ...(memory?.performanceTrends?.consistencyNotes ?? []),
    ],
    10,
  );

  return {
    dominantPatterns,
    recurringPatterns,
    cognitivePatterns,
    performanceTrends,
    resolvedPatterns,
    currentState,
  };
}

export async function buildHistoricalStateReviewInput(userId: number | string) {
  const resolvedUserId = String(userId);

  const [timeline, memoryRows, allCases, adjustments, outcomes] =
    await Promise.all([
      db
        .select({
          id: timelineEntries.id,
          type: timelineEntries.type,
          summary: timelineEntries.summary,
          createdAt: timelineEntries.createdAt,
        })
        .from(timelineEntries)
        .where(eq(timelineEntries.userId, resolvedUserId))
        .orderBy(asc(timelineEntries.createdAt), asc(timelineEntries.id)),
      db
        .select({ memory: userMemory.memory })
        .from(userMemory)
        .where(eq(userMemory.userId, resolvedUserId))
        .limit(1),
      db
        .select({
          id: cases.id,
          movementContext: cases.movementContext,
          activityType: cases.activityType,
          status: cases.status,
        })
        .from(cases)
        .where(eq(cases.userId, resolvedUserId))
        .orderBy(asc(cases.id)),
      db
        .select({
          id: caseAdjustments.id,
          caseId: caseAdjustments.caseId,
          cue: caseAdjustments.cue,
          mechanicalFocus: caseAdjustments.mechanicalFocus,
          outcomeId: caseOutcomes.id,
          outcomeResult: caseOutcomes.result,
          outcomeFeedback: caseOutcomes.userFeedback,
        })
        .from(caseAdjustments)
        .innerJoin(cases, eq(caseAdjustments.caseId, cases.id))
        .leftJoin(
          caseOutcomes,
          eq(caseAdjustments.id, caseOutcomes.adjustmentId),
        )
        .where(eq(cases.userId, resolvedUserId))
        .orderBy(desc(caseAdjustments.id), desc(caseOutcomes.id)),
      db
        .select({
          id: caseOutcomes.id,
          caseId: caseOutcomes.caseId,
          result: caseOutcomes.result,
          userFeedback: caseOutcomes.userFeedback,
        })
        .from(caseOutcomes)
        .innerJoin(cases, eq(caseOutcomes.caseId, cases.id))
        .where(eq(cases.userId, resolvedUserId))
        .orderBy(desc(caseOutcomes.id)),
    ]);

  const memory = memoryRows[0]?.memory ?? {};
  const memorySections = collectMemorySections(memory);

  const earliestEntries = timeline.slice(0, 8);

  const entryState = uniqueCompact(
    earliestEntries.map((entry) => entry.summary),
    8,
  );

  const earlyPatterns = uniqueCompact(
    earliestEntries
      .map((entry) => entry.summary)
      .filter((summary) => isProblemSignal(summary)),
    6,
  );

  const adjustmentsById = new Map<number, (typeof adjustments)[number]>();
  for (const adjustment of adjustments) {
    if (!adjustmentsById.has(adjustment.id)) {
      adjustmentsById.set(adjustment.id, adjustment);
    }
  }

  const keyAdjustments = uniqueCompact(
    adjustments
      .filter(
        (adjustment) =>
          adjustment.outcomeId != null &&
          (isPositiveText(adjustment.outcomeResult) ||
            isPositiveText(adjustment.outcomeFeedback)),
      )
      .map((adjustment) =>
        summarizeAdjustment(
          adjustment.cue,
          adjustment.mechanicalFocus,
          adjustment.outcomeFeedback ?? adjustment.outcomeResult,
        ),
      ),
    8,
  );

  const failedAdjustments = uniqueCompact(
    Array.from(adjustmentsById.values())
      .filter((adjustment) => {
        if (adjustment.outcomeId == null) return true;
        return (
          isNegativeText(adjustment.outcomeResult) ||
          isNegativeText(adjustment.outcomeFeedback)
        );
      })
      .map((adjustment) =>
        summarizeAdjustment(
          adjustment.cue,
          adjustment.mechanicalFocus,
          adjustment.outcomeFeedback ??
            adjustment.outcomeResult ??
            "No clear resolution recorded",
        ),
      ),
    8,
  );

  const workingPolicies = uniqueCompact(
    keyAdjustments.map((adjustment) => {
      const text = cleanText(adjustment, 180);
      if (!text) return null;
      const [policy] = text.split(" -> ");
      return policy;
    }),
    6,
  );

  const meaningfulOutcomes = uniqueCompact(
    outcomes.map((outcome) =>
      summarizeOutcome(outcome.result, outcome.userFeedback),
    ),
    8,
  );

  const regressions = uniqueCompact(
    [
      ...timeline
        .filter(
          (entry) => entry.type === "outcome" || isNegativeText(entry.summary),
        )
        .map((entry) => entry.summary),
      ...failedAdjustments,
    ],
    8,
  );

  const resolvedPatterns = uniqueCompact(
    [
      ...memorySections.resolvedPatterns,
      ...meaningfulOutcomes.filter((outcome) => isPositiveText(outcome)),
      ...allCases
        .filter((caseRow) => /resolved/i.test(String(caseRow.status ?? "")))
        .map((caseRow) => caseRow.movementContext || caseRow.activityType),
    ],
    8,
  );

  const caseSummary = `User has engaged in ${allCases.length} tracked investigations.`;

  return {
    generatedAt: new Date().toISOString(),
    entryState,
    earlyPatterns,
    dominantPatterns: memorySections.dominantPatterns,
    recurringPatterns: memorySections.recurringPatterns,
    cognitivePatterns: memorySections.cognitivePatterns,
    performanceTrends: memorySections.performanceTrends,
    keyAdjustments,
    failedAdjustments,
    workingPolicies,
    meaningfulOutcomes,
    regressions,
    resolvedPatterns,
    caseSummary,
    currentState: memorySections.currentState,
  };
}

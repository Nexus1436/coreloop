export type HistoricalStateReviewInput = {
  userId?: number | string;
  generatedAt?: string;

  entryState?: string[];
  earlyPatterns?: string[];
  dominantPatterns?: string[];
  recurringPatterns?: string[];
  resolvedPatterns?: string[];

  keyAdjustments?: string[];
  failedAdjustments?: string[];
  workingPolicies?: string[];

  meaningfulOutcomes?: string[];
  regressions?: string[];
  performanceTrends?: string[];
  cognitivePatterns?: string[];

  phaseSummaries?: string[];
  caseSummary?: string;

  currentState?: string[];
};

function cleanItems(items?: string[]): string[] {
  if (!items) return [];
  return items.map((item) => item.trim()).filter(Boolean);
}

function formatSection(label: string, items?: string[]): string | null {
  const cleaned = cleanItems(items);
  if (cleaned.length === 0) return null;
  return `${label}: ${cleaned.join("; ")}`;
}

function buildInterpretation(input: HistoricalStateReviewInput): string | null {
  const interpretationParts: string[] = [];

  if (cleanItems(input.earlyPatterns).length > 0) {
    interpretationParts.push(
      "initial state showed identifiable pattern pressure",
    );
  }

  if (cleanItems(input.keyAdjustments).length > 0) {
    interpretationParts.push(
      "meaningful adjustments were introduced over time",
    );
  }

  if (cleanItems(input.failedAdjustments).length > 0) {
    interpretationParts.push("some interventions did not stabilize state");
  }

  if (cleanItems(input.workingPolicies).length > 0) {
    interpretationParts.push(
      "durable operating rules emerged from repeated interaction",
    );
  }

  if (cleanItems(input.resolvedPatterns).length > 0) {
    interpretationParts.push("some prior constraints were reduced or absorbed");
  }

  if (cleanItems(input.regressions).length > 0) {
    interpretationParts.push(
      "progression included periods of regression or instability",
    );
  }

  if (cleanItems(input.currentState).length > 0) {
    interpretationParts.push(
      "current state reflects accumulated adaptation rather than isolated change",
    );
  }

  if (interpretationParts.length === 0) return null;

  return `System interpretation: ${interpretationParts.join(", ")}.`;
}

export function buildHistoricalStateReview(
  input: HistoricalStateReviewInput,
): string {
  const sections: string[] = [];

  if (input.generatedAt?.trim()) {
    sections.push(
      `Historical state review generated at ${input.generatedAt.trim()}.`,
    );
  } else {
    sections.push("Historical state review.");
  }

  const entryState = formatSection("Entry state", input.entryState);
  if (entryState) sections.push(entryState);

  const earlyPatterns = formatSection("Early patterns", input.earlyPatterns);
  if (earlyPatterns) sections.push(earlyPatterns);

  const dominantPatterns = formatSection(
    "Dominant patterns",
    input.dominantPatterns,
  );
  if (dominantPatterns) sections.push(dominantPatterns);

  const recurringPatterns = formatSection(
    "Recurring patterns",
    input.recurringPatterns,
  );
  if (recurringPatterns) sections.push(recurringPatterns);

  const keyAdjustments = formatSection("Key adjustments", input.keyAdjustments);
  if (keyAdjustments) sections.push(keyAdjustments);

  const failedAdjustments = formatSection(
    "Failed adjustments",
    input.failedAdjustments,
  );
  if (failedAdjustments) sections.push(failedAdjustments);

  const workingPolicies = formatSection(
    "Working policies",
    input.workingPolicies,
  );
  if (workingPolicies) sections.push(workingPolicies);

  const outcomes = formatSection(
    "Meaningful outcomes",
    input.meaningfulOutcomes,
  );
  if (outcomes) sections.push(outcomes);

  const regressions = formatSection("Regressions", input.regressions);
  if (regressions) sections.push(regressions);

  const performanceTrends = formatSection(
    "Performance trends",
    input.performanceTrends,
  );
  if (performanceTrends) sections.push(performanceTrends);

  const cognitivePatterns = formatSection(
    "Cognitive patterns",
    input.cognitivePatterns,
  );
  if (cognitivePatterns) sections.push(cognitivePatterns);

  const resolvedPatterns = formatSection(
    "Resolved patterns",
    input.resolvedPatterns,
  );
  if (resolvedPatterns) sections.push(resolvedPatterns);

  const phaseSummaries = formatSection(
    "Phase progression",
    input.phaseSummaries,
  );
  if (phaseSummaries) sections.push(phaseSummaries);

  if (input.caseSummary?.trim()) {
    sections.push(`Case context: ${input.caseSummary.trim()}`);
  }

  const currentState = formatSection("Current state", input.currentState);
  if (currentState) sections.push(currentState);

  const interpretation = buildInterpretation(input);
  if (interpretation) sections.push(interpretation);

  return sections.join("\n");
}

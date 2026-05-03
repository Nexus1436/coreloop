import type { Express, Request, Response } from "express";
import { desc } from "drizzle-orm";

import { db } from "./db";
import {
  cases,
  caseSignals,
  caseHypotheses,
  caseAdjustments,
  caseOutcomes,
  caseReasoningSnapshots,
} from "@shared/schema";

/* =====================================================
   ANALYTICS API
   Single endpoint: GET /api/analytics
   Returns all data needed for the Interloop Analytics Dashboard.
   Protected by ANALYTICS_API_KEY header.

   Schema notes (from shared/schema.ts):
   - cases: id, userId, conversationId, movementContext, activityType, status, createdAt, updatedAt
   - caseSignals: id, caseId, userId, bodyRegion, signalType, movementContext, activityType, description
   - caseHypotheses: id, caseId, signalId, hypothesis, confidence, createdAt
   - caseAdjustments: id, caseId, hypothesisId, adjustmentType, cue, mechanicalFocus, createdAt
   - caseOutcomes: id, caseId, adjustmentId, result, userFeedback, createdAt
   - caseReasoningSnapshots: durable CoreLoop reasoning chain for analytics
===================================================== */

// ── Body region extraction from signal text ───────────────────
// Maps keyword patterns to canonical body region names.
// Order matters: more specific terms should come first.
const BODY_REGION_KEYWORDS: { region: string; keywords: string[] }[] = [
  { region: "Ankle", keywords: ["ankle", "ankles"] },
  { region: "Knee", keywords: ["knee", "knees", "knock-kneed", "popliteal"] },
  { region: "Hip", keywords: ["hip", "hips"] },
  {
    region: "Lower Back",
    keywords: ["lower back", "lumbar", "tailbone", "sacrum", "disc", "discs"],
  },
  { region: "Back", keywords: ["back", "spine", "spinal", "vertebra"] },
  { region: "Glutes", keywords: ["glute", "glutes", "gluteal"] },
  { region: "Hamstrings", keywords: ["hamstring", "hamstrings"] },
  { region: "Quads", keywords: ["quad", "quads", "quadricep"] },
  { region: "Calves", keywords: ["calf", "calves"] },
  { region: "Legs", keywords: ["leg", "legs"] },
  { region: "Shoulder", keywords: ["shoulder", "shoulders", "rotator"] },
  { region: "Neck", keywords: ["neck", "cervical"] },
  { region: "Foot", keywords: ["foot", "feet", "plantar", "heel", "arch"] },
  { region: "Wrist", keywords: ["wrist", "wrists"] },
  { region: "Elbow", keywords: ["elbow", "elbows"] },
  { region: "Core", keywords: ["core", "abdom", "abs"] },
];

function extractBodyRegion(signal: string | null | undefined): string {
  if (!signal) return "General";
  const lower = signal.toLowerCase();
  for (const { region, keywords } of BODY_REGION_KEYWORDS) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return region;
    }
  }
  return "General";
}

export function registerAnalyticsRoutes(app: Express): void {
  // CORS preflight
  app.options("/api/analytics", (_req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "x-analytics-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.sendStatus(200);
  });

  app.get("/api/analytics", async (req: Request, res: Response) => {
    // ── API Key Auth ──────────────────────────────────────────
    const apiKey = req.headers["x-analytics-key"];
    const expectedKey = process.env.ANALYTICS_API_KEY;

    if (expectedKey && apiKey !== expectedKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      // ── 1. Load all data ──────────────────────────────────
      const allCases = await db
        .select({
          id: cases.id,
          userId: cases.userId,
          movementContext: cases.movementContext,
          activityType: cases.activityType,
          createdAt: cases.createdAt,
        })
        .from(cases)
        .orderBy(desc(cases.createdAt));

      // caseSignals.description is the signal text
      const allSignals = await db
        .select({
          caseId: caseSignals.caseId,
          signal: caseSignals.description,
          bodyRegion: caseSignals.bodyRegion,
          signalType: caseSignals.signalType,
          movementContext: caseSignals.movementContext,
          activityType: caseSignals.activityType,
        })
        .from(caseSignals);

      const allHypotheses = await db
        .select({
          caseId: caseHypotheses.caseId,
          hypothesis: caseHypotheses.hypothesis,
        })
        .from(caseHypotheses);

      const allAdjustments = await db
        .select({
          id: caseAdjustments.id,
          caseId: caseAdjustments.caseId,
          cue: caseAdjustments.cue,
          adjustmentType: caseAdjustments.adjustmentType,
          mechanicalFocus: caseAdjustments.mechanicalFocus,
        })
        .from(caseAdjustments);

      const allOutcomes = await db
        .select({
          caseId: caseOutcomes.caseId,
          adjustmentId: caseOutcomes.adjustmentId,
          result: caseOutcomes.result,
          userFeedback: caseOutcomes.userFeedback,
          createdAt: caseOutcomes.createdAt,
        })
        .from(caseOutcomes);

      const allReasoningSnapshots = await db
        .select({
          id: caseReasoningSnapshots.id,
          caseId: caseReasoningSnapshots.caseId,
          sportDomain: caseReasoningSnapshots.sportDomain,
          activityMovement: caseReasoningSnapshots.activityMovement,
          bodyRegion: caseReasoningSnapshots.bodyRegion,
          movementFamily: caseReasoningSnapshots.movementFamily,
          mechanicalEnvironment: caseReasoningSnapshots.mechanicalEnvironment,
          failureCandidates: caseReasoningSnapshots.failureCandidates,
          dominantFailure: caseReasoningSnapshots.dominantFailure,
          dominantFailureConfidence:
            caseReasoningSnapshots.dominantFailureConfidence,
          activeLever: caseReasoningSnapshots.activeLever,
          activeTest: caseReasoningSnapshots.activeTest,
          activeHypothesisId: caseReasoningSnapshots.activeHypothesisId,
          activeAdjustmentId: caseReasoningSnapshots.activeAdjustmentId,
          createdAt: caseReasoningSnapshots.createdAt,
        })
        .from(caseReasoningSnapshots)
        .orderBy(desc(caseReasoningSnapshots.id));

      // ── 2. Build lookup maps ──────────────────────────────
      const signalsByCase = new Map<number, typeof allSignals>();
      for (const s of allSignals) {
        if (!signalsByCase.has(s.caseId)) signalsByCase.set(s.caseId, []);
        signalsByCase.get(s.caseId)!.push(s);
      }

      const hypothesisByCase = new Map<number, string>();
      for (const h of allHypotheses) {
        if (!hypothesisByCase.has(h.caseId)) {
          hypothesisByCase.set(h.caseId, h.hypothesis ?? "");
        }
      }

      const adjustmentByCase = new Map<number, (typeof allAdjustments)[0]>();
      for (const a of allAdjustments) {
        adjustmentByCase.set(a.caseId, a);
      }

      const outcomeByCase = new Map<number, (typeof allOutcomes)[0]>();
      for (const o of allOutcomes) {
        outcomeByCase.set(o.caseId, o);
      }

      const reasoningByCase = new Map<
        number,
        (typeof allReasoningSnapshots)[0]
      >();
      for (const reasoning of allReasoningSnapshots) {
        if (!reasoningByCase.has(reasoning.caseId)) {
          reasoningByCase.set(reasoning.caseId, reasoning);
        }
      }

      // ── 3. Build flat case records ────────────────────────
      const caseRecords = allCases.map((c) => {
        const signals = signalsByCase.get(c.id) ?? [];
        const primarySignal = signals[0];
        const hypothesis = hypothesisByCase.get(c.id) ?? null;
        const adjustment = adjustmentByCase.get(c.id) ?? null;
        const outcome = outcomeByCase.get(c.id) ?? null;
        const reasoning = reasoningByCase.get(c.id) ?? null;

        const signalText = primarySignal?.signal ?? null;

        // Use stored bodyRegion if available; otherwise extract from signal text
        const storedRegion = primarySignal?.bodyRegion;
        const body_region =
          storedRegion && storedRegion.trim() !== ""
            ? storedRegion
            : extractBodyRegion(signalText);

        // Use activityType as the activity/sport label
        const sport =
          reasoning?.sportDomain ??
          c.activityType ??
          primarySignal?.activityType ??
          c.movementContext ??
          "General";

        return {
          case_id: `CASE-${String(c.id).padStart(4, "0")}`,
          raw_id: c.id,
          user_id: c.userId, // ← included so dashboard can group by user
          signal: signalText ?? "Unknown signal",
          body_region: reasoning?.bodyRegion ?? body_region,
          signal_type: primarySignal?.signalType ?? "Unknown",
          sport,
          sport_domain: reasoning?.sportDomain ?? sport,
          activity_movement:
            reasoning?.activityMovement ??
            primarySignal?.movementContext ??
            c.movementContext ??
            "general",
          movement_family: reasoning?.movementFamily ?? null,
          mechanical_environment: reasoning?.mechanicalEnvironment ?? null,
          failure_candidates: reasoning?.failureCandidates ?? null,
          dominant_failure: reasoning?.dominantFailure ?? null,
          dominant_failure_confidence:
            reasoning?.dominantFailureConfidence ?? null,
          active_lever: reasoning?.activeLever ?? null,
          active_test: reasoning?.activeTest ?? adjustment?.cue ?? null,
          active_hypothesis_id: reasoning?.activeHypothesisId ?? null,
          active_adjustment_id: reasoning?.activeAdjustmentId ?? adjustment?.id ?? null,
          movement_context:
            primarySignal?.movementContext ?? c.movementContext ?? "general",
          hypothesis: hypothesis,
          adjustment: adjustment?.cue ?? null,
          adjustment_type: adjustment?.adjustmentType ?? null,
          outcome: outcome?.result ?? null,
          user_feedback: outcome?.userFeedback ?? null,
          has_hypothesis: !!hypothesis,
          has_adjustment: !!adjustment,
          has_outcome: !!outcome,
          created_at: c.createdAt,
        };
      });

      const total = caseRecords.length;

      // ── 4. Signal Frequency ───────────────────────────────
      const signalFreqMap = new Map<string, number>();
      for (const c of caseRecords) {
        if (c.signal && c.signal !== "Unknown signal") {
          signalFreqMap.set(c.signal, (signalFreqMap.get(c.signal) ?? 0) + 1);
        }
      }
      const signalFrequency = Array.from(signalFreqMap.entries())
        .map(([signal, count]) => ({ signal, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);

      // ── 5. Outcome Distribution ───────────────────────────
      const outcomeMap = new Map<string, number>();
      for (const c of caseRecords) {
        if (c.has_outcome && c.outcome) {
          const normalized =
            c.outcome.charAt(0).toUpperCase() +
            c.outcome.slice(1).toLowerCase();
          outcomeMap.set(normalized, (outcomeMap.get(normalized) ?? 0) + 1);
        }
      }
      const outcomeDistribution = Array.from(outcomeMap.entries()).map(
        ([outcome, count]) => ({ outcome, count }),
      );

      // ── 6. Body Region Distribution ───────────────────────
      const regionMap = new Map<string, number>();
      for (const c of caseRecords) {
        if (c.body_region && c.body_region !== "General") {
          regionMap.set(c.body_region, (regionMap.get(c.body_region) ?? 0) + 1);
        }
      }
      const bodyRegionDistribution = Array.from(regionMap.entries())
        .map(([region, count]) => ({ region, count }))
        .sort((a, b) => b.count - a.count);

      // ── 7. Adjustment Effectiveness ───────────────────────
      const adjEffMap = new Map<string, { total: number; improved: number }>();
      for (const c of caseRecords) {
        if (!c.adjustment) continue;
        const key = c.adjustment.slice(0, 80);
        if (!adjEffMap.has(key)) adjEffMap.set(key, { total: 0, improved: 0 });
        const entry = adjEffMap.get(key)!;
        entry.total++;
        if (c.outcome?.toLowerCase().includes("improv")) entry.improved++;
      }
      const adjustmentEffectiveness = Array.from(adjEffMap.entries())
        .map(([adjustment, { total, improved }]) => ({
          adjustment,
          total,
          improved,
          rate: total > 0 ? Math.round((improved / total) * 100) : 0,
        }))
        .sort((a, b) => b.improved - a.improved)
        .slice(0, 10);

      // ── 8. Hypothesis Success Rates ───────────────────────
      const hypMap = new Map<string, { total: number; improved: number }>();
      for (const c of caseRecords) {
        if (!c.hypothesis) continue;
        const key = c.hypothesis.slice(0, 100);
        if (!hypMap.has(key)) hypMap.set(key, { total: 0, improved: 0 });
        const entry = hypMap.get(key)!;
        entry.total++;
        if (c.outcome?.toLowerCase().includes("improv")) entry.improved++;
      }
      const hypothesisSuccessRates = Array.from(hypMap.entries())
        .map(([hypothesis, { total, improved }]) => ({
          hypothesis,
          total,
          improved,
          rate: total > 0 ? Math.round((improved / total) * 100) : 0,
        }))
        .sort((a, b) => b.rate - a.rate)
        .slice(0, 10);

      // ── 9. Signal → Adjustment Mapping ───────────────────
      const sigAdjMap = new Map<
        string,
        Map<string, { total: number; improved: number }>
      >();
      for (const c of caseRecords) {
        if (!c.signal || !c.adjustment) continue;
        if (!sigAdjMap.has(c.signal)) sigAdjMap.set(c.signal, new Map());
        const adjEntry = sigAdjMap.get(c.signal)!;
        const adjKey = c.adjustment.slice(0, 80);
        if (!adjEntry.has(adjKey))
          adjEntry.set(adjKey, { total: 0, improved: 0 });
        const entry = adjEntry.get(adjKey)!;
        entry.total++;
        if (c.outcome?.toLowerCase().includes("improv")) entry.improved++;
      }
      const signalToAdjustmentMapping = Array.from(sigAdjMap.entries())
        .map(([signal, adjMap]) => {
          let bestAdj = "";
          let bestRate = 0;
          let bestTotal = 0;
          for (const [adj, { total, improved }] of adjMap.entries()) {
            const rate = total > 0 ? improved / total : 0;
            if (rate > bestRate || (rate === bestRate && total > bestTotal)) {
              bestAdj = adj;
              bestRate = rate;
              bestTotal = total;
            }
          }
          return {
            signal,
            bestAdjustment: bestAdj,
            cases: bestTotal,
            rate: Math.round(bestRate * 100),
          };
        })
        .sort((a, b) => b.rate - a.rate)
        .slice(0, 12);

      // ── 10. Investigation Funnel ──────────────────────────
      const withHyp = caseRecords.filter((c) => c.has_hypothesis).length;
      const withAdj = caseRecords.filter((c) => c.has_adjustment).length;
      const withOut = caseRecords.filter((c) => c.has_outcome).length;
      const investigationFunnel = [
        { stage: "Signal Reported", count: total, pct: 100 },
        {
          stage: "Hypothesis Formed",
          count: withHyp,
          pct: total > 0 ? Math.round((withHyp / total) * 100) : 0,
        },
        {
          stage: "Adjustment Suggested",
          count: withAdj,
          pct: total > 0 ? Math.round((withAdj / total) * 100) : 0,
        },
        {
          stage: "Outcome Reported",
          count: withOut,
          pct: total > 0 ? Math.round((withOut / total) * 100) : 0,
        },
      ];

      // ── 11. Adjustment Adoption Rate ──────────────────────
      const adoptionRate = {
        withAdjustment: withAdj,
        withOutcome: withOut,
        rate: withAdj > 0 ? Math.round((withOut / withAdj) * 100) : 0,
      };

      // ── 12. Signal Vocabulary ─────────────────────────────
      const stopWords = new Set([
        "the",
        "a",
        "an",
        "and",
        "or",
        "but",
        "in",
        "on",
        "at",
        "to",
        "for",
        "of",
        "with",
        "my",
        "i",
        "it",
        "is",
        "was",
        "that",
        "this",
        "when",
        "during",
        "after",
        "before",
        "feel",
        "feels",
        "feeling",
        "have",
        "has",
        "get",
        "gets",
        "getting",
        "been",
        "be",
        "left",
        "right",
        "side",
        "both",
        "some",
        "more",
        "less",
        "very",
        "really",
        "just",
        "like",
        "seems",
        "noticed",
        "notice",
        "kind",
        "bit",
        "little",
        "lot",
      ]);
      const wordMap = new Map<string, number>();
      for (const c of caseRecords) {
        const text = (c.signal + " " + (c.user_feedback ?? "")).toLowerCase();
        const words = text.match(/\b[a-z]{4,}\b/g) ?? [];
        for (const w of words) {
          if (!stopWords.has(w)) {
            wordMap.set(w, (wordMap.get(w) ?? 0) + 1);
          }
        }
      }
      const signalVocabulary = Array.from(wordMap.entries())
        .map(([word, count]) => ({ word, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 40);

      // ── 13. Return User Metrics ───────────────────────────
      const userCaseMap = new Map<string, number>();
      for (const c of allCases) {
        userCaseMap.set(c.userId, (userCaseMap.get(c.userId) ?? 0) + 1);
      }
      const totalUsers = userCaseMap.size;
      const returnUsers = Array.from(userCaseMap.values()).filter(
        (n) => n > 1,
      ).length;
      const returnUserMetrics = {
        totalUsers,
        returnRate:
          totalUsers > 0 ? Math.round((returnUsers / totalUsers) * 100) : 0,
        avgSessions:
          totalUsers > 0 ? Math.round(allCases.length / totalUsers) : 0,
        avgCasesPerUser:
          totalUsers > 0 ? Math.round(allCases.length / totalUsers) : 0,
      };

      // ── 14. Activity × Body Region Correlation ────────────
      const sportMap = new Map<string, Map<string, number>>();
      for (const c of caseRecords) {
        const sport = c.sport ?? "General";
        if (!sportMap.has(sport)) sportMap.set(sport, new Map());
        const regionEntry = sportMap.get(sport)!;
        const region = c.body_region ?? "General";
        regionEntry.set(region, (regionEntry.get(region) ?? 0) + 1);
      }
      const sportBodyRegionCorrelation = Array.from(sportMap.entries())
        .map(([sport, rMap]) => {
          const regions: Record<string, number> = {};
          let topRegion = "";
          let topCount = 0;
          let sportTotal = 0;
          for (const [region, count] of rMap.entries()) {
            regions[region] = count;
            sportTotal += count;
            if (count > topCount) {
              topCount = count;
              topRegion = region;
            }
          }
          return { sport, total: sportTotal, topRegion, regions };
        })
        .sort((a, b) => b.total - a.total);

      // ── 15. Outcome Timing ────────────────────────────────
      const timingBuckets = [
        { label: "< 1hr", min: 0, max: 1 },
        { label: "1–6hr", min: 1, max: 6 },
        { label: "6–24hr", min: 6, max: 24 },
        { label: "1–3d", min: 24, max: 72 },
        { label: "> 3d", min: 72, max: Infinity },
      ];
      const timingCounts = timingBuckets.map((b) => ({
        label: b.label,
        count: 0,
      }));
      for (const o of allOutcomes) {
        const caseRow = allCases.find((c) => c.id === o.caseId);
        if (!caseRow || !o.createdAt || !caseRow.createdAt) continue;
        const diffHours =
          (new Date(o.createdAt).getTime() -
            new Date(caseRow.createdAt).getTime()) /
          3_600_000;
        for (let i = 0; i < timingBuckets.length; i++) {
          if (
            diffHours >= timingBuckets[i].min &&
            diffHours < timingBuckets[i].max
          ) {
            timingCounts[i].count++;
            break;
          }
        }
      }

      // ── 16. KPI ───────────────────────────────────────────
      const improvedCount = caseRecords.filter((c) =>
        c.outcome?.toLowerCase().includes("improv"),
      ).length;
      const casesWithOutcome = caseRecords.filter((c) => c.has_outcome).length;
      const uniqueSignals = new Set(
        caseRecords.map((c) => c.signal).filter((s) => s !== "Unknown signal"),
      ).size;
      const uniqueRegions = new Set(
        caseRecords.map((c) => c.body_region).filter((r) => r !== "General"),
      ).size;

      const kpi = {
        totalCases: total,
        // Overall rate: improved / all cases
        improvedPctOverall:
          total > 0 ? Math.round((improvedCount / total) * 100) : 0,
        // Closed-case rate: improved / cases with outcomes
        improvedPctClosed:
          casesWithOutcome > 0
            ? Math.round((improvedCount / casesWithOutcome) * 100)
            : 0,
        // Legacy field kept for compatibility
        improvedPct: total > 0 ? Math.round((improvedCount / total) * 100) : 0,
        improvedCount,
        casesWithOutcome,
        uniqueSignals,
        uniqueRegions,
        avgMessagesToAdjustment: 3,
        // Fields expected by neonDb.ts AnalyticsPayload
        improvedCases: improvedCount,
        avgMessages: 3,
      };

      // ── Response ──────────────────────────────────────────
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "x-analytics-key");
      res.json({
        kpi,
        signalFrequency,
        outcomeDistribution,
        bodyRegion: bodyRegionDistribution,
        bodyRegionDistribution,
        adjustmentEffectiveness,
        hypothesisRates: hypothesisSuccessRates,
        hypothesisSuccessRates,
        signalMapping: signalToAdjustmentMapping,
        signalToAdjustmentMapping,
        funnel: investigationFunnel,
        investigationFunnel,
        adoptionRate,
        signalVocabulary,
        returnUserMetrics,
        sportCorrelation: sportBodyRegionCorrelation,
        sportBodyRegionCorrelation,
        outcomeTiming: timingCounts,
        cases: caseRecords,
      });
    } catch (err) {
      console.error("[/api/analytics error]", err);
      res.status(500).json({ error: "Analytics query failed" });
    }
  });
}

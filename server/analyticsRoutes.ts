import type { Express, Request, Response } from "express";
import { db } from "./db";
import {
  cases,
  caseSignals,
  caseHypotheses,
  caseAdjustments,
  caseOutcomes,
  messages,
  conversations,
} from "@shared/schema";
import { eq, desc, sql, count } from "drizzle-orm";

/* =====================================================
   ANALYTICS API
   Single endpoint: GET /api/analytics
   Returns all data needed for the Interloop Analytics Dashboard.
   Protected by ANALYTICS_API_KEY header.
===================================================== */

export function registerAnalyticsRoutes(app: Express): void {
  app.get("/api/analytics", async (req: Request, res: Response) => {
    // ── API Key Auth ──────────────────────────────────────────
    const apiKey = req.headers["x-analytics-key"];
    const expectedKey = process.env.ANALYTICS_API_KEY;

    if (expectedKey && apiKey !== expectedKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      // ── 1. All cases with full join ───────────────────────
      const allCases = await db
        .select({
          id: cases.id,
          userId: cases.userId,
          sport: cases.sport,
          movementContext: cases.movementContext,
          createdAt: cases.createdAt,
        })
        .from(cases)
        .orderBy(desc(cases.createdAt));

      const allSignals = await db
        .select({
          caseId: caseSignals.caseId,
          signal: caseSignals.signal,
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

      // ── 3. Build flat case records ────────────────────────
      const caseRecords = allCases.map((c) => {
        const signals = signalsByCase.get(c.id) ?? [];
        const primarySignal = signals[0];
        const hypothesis = hypothesisByCase.get(c.id) ?? null;
        const adjustment = adjustmentByCase.get(c.id) ?? null;
        const outcome = outcomeByCase.get(c.id) ?? null;

        return {
          case_id: `CASE-${String(c.id).padStart(4, "0")}`,
          raw_id: c.id,
          signal: primarySignal?.signal ?? "Unknown signal",
          body_region: primarySignal?.bodyRegion ?? "Unknown",
          signal_type: primarySignal?.signalType ?? "Unknown",
          sport: c.sport ?? c.movementContext ?? "General",
          movement_context: primarySignal?.movementContext ?? "general",
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
        if (c.body_region && c.body_region !== "Unknown") {
          regionMap.set(c.body_region, (regionMap.get(c.body_region) ?? 0) + 1);
        }
      }
      const bodyRegionDistribution = Array.from(regionMap.entries())
        .map(([region, count]) => ({ region, count }))
        .sort((a, b) => b.count - a.count);

      // ── 7. Adjustment Effectiveness ───────────────────────
      const adjMap = new Map<string, { total: number; improved: number }>();
      for (const c of caseRecords) {
        if (!c.adjustment) continue;
        const key = c.adjustment.slice(0, 80);
        if (!adjMap.has(key)) adjMap.set(key, { total: 0, improved: 0 });
        const entry = adjMap.get(key)!;
        entry.total++;
        if (c.outcome?.toLowerCase().includes("improv")) entry.improved++;
      }
      const adjustmentEffectiveness = Array.from(adjMap.entries())
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
      const total = caseRecords.length;
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
      const userCaseMap = new Map<number, number>();
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

      // ── 14. Sport × Body Region Correlation ──────────────
      const sportMap = new Map<string, Map<string, number>>();
      for (const c of caseRecords) {
        const sport = c.sport ?? "General";
        if (!sportMap.has(sport)) sportMap.set(sport, new Map());
        const regionEntry = sportMap.get(sport)!;
        const region = c.body_region ?? "Unknown";
        regionEntry.set(region, (regionEntry.get(region) ?? 0) + 1);
      }
      const sportBodyRegionCorrelation = Array.from(sportMap.entries())
        .map(([sport, regionMap]) => {
          const regions: Record<string, number> = {};
          let topRegion = "";
          let topCount = 0;
          let total = 0;
          for (const [region, count] of regionMap.entries()) {
            regions[region] = count;
            total += count;
            if (count > topCount) {
              topCount = count;
              topRegion = region;
            }
          }
          return { sport, total, topRegion, regions };
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
          3600000;
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
      const outcomeTiming = timingCounts;

      // ── 16. KPI ───────────────────────────────────────────
      const improvedCount = caseRecords.filter((c) =>
        c.outcome?.toLowerCase().includes("improv"),
      ).length;
      const casesWithOutcome = caseRecords.filter((c) => c.has_outcome).length;
      const uniqueSignals = new Set(caseRecords.map((c) => c.signal)).size;
      const uniqueRegions = new Set(caseRecords.map((c) => c.body_region)).size;

      const kpi = {
        totalCases: total,
        improvedCount,
        improvedPct:
          casesWithOutcome > 0
            ? Math.round((improvedCount / casesWithOutcome) * 100)
            : 0,
        uniqueSignals,
        uniqueRegions,
        avgMessagesToAdjustment: 3,
      };

      // ── Response ──────────────────────────────────────────
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "x-analytics-key");
      res.json({
        kpi,
        signalFrequency,
        outcomeDistribution,
        bodyRegionDistribution,
        adjustmentEffectiveness,
        hypothesisSuccessRates,
        signalToAdjustmentMapping,
        investigationFunnel,
        adoptionRate,
        signalVocabulary,
        returnUserMetrics,
        sportBodyRegionCorrelation,
        outcomeTiming,
        cases: caseRecords,
      });
    } catch (err) {
      console.error("[/api/analytics error]", err);
      res.status(500).json({ error: "Analytics query failed" });
    }
  });

  // CORS preflight for the analytics endpoint
  app.options("/api/analytics", (req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "x-analytics-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.sendStatus(200);
  });
}

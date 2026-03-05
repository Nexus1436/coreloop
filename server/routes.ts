import type { Express, Request, Response } from "express";
import type { Server as HTTPServer } from "http";

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { toFile } from "openai/uploads";
import { asc, desc, eq } from "drizzle-orm";

import { db } from "./db";
import { conversations, messages } from "@shared/schema";

import { getMemory, updateMemory, type InterloopMemory } from "./memory/memory";
import { extractMemory } from "./memory/extract";

/* =====================================================
   OPENAI CLIENT
===================================================== */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/* =====================================================
   SYSTEM PROMPT (UNCHANGED)
===================================================== */

const SYSTEM_PROMPT = `
Interloop by Signal

BASE NARRATIVE

────────────────────────────────

IDENTITY

Interloop is a high-level movement reconstruction system.

It does not coach.
It does not diagnose.
It does not prescribe treatment.

It reverse-engineers force behavior.

It sees:
• where force is created
• how it transfers
• where it compresses
• where it redirects
• where it leaks
• where it fails to exit

It reconstructs sequencing across time and across activities.

It reasons longitudinally.

It functions like a master movement analyst with memory.

It does not treat tissue.

────────────────────────────────

NAME INTEGRATION

If memory contains a name:
• Use it naturally.
• Use it sparingly.
• Place it during stabilization or narrowing.
• Never mechanically begin every response with it.

If no name exists:
• Introduce Interloop clearly and confidently.
• Explain what it does.
• Then ask: “What should I call you?”
• Wait for the answer before proceeding.

Never skip name acquisition.
Never re-ask once established.

────────────────────────────────

PRIMARY LAW — SIGNAL FIRST

All reasoning begins from signal.

Signal is any deviation in force behavior — not just pain.

Before reconstructing structure, Interloop must anchor:

• When in the sequence does it occur?
• What changes compared to a clean repetition?
• Where does force feel concentrated or unstable?
• What phase of movement is active at that moment?

Signal anchoring must feel conversational.
Never output checklists.
Never interrogate mechanically.

Stabilize → Narrow → Anchor → Reconstruct.

Mechanics are downstream of signal.

────────────────────────────────

MASTER COACH AUTHORITY RULE

Interloop speaks as someone who understands correct sequencing.

It does not hedge.
It does not speculate loosely.
It does not list parallel equal causes.

When ambiguity exists:

1. State what proper sequencing should look like.
2. Describe the most coherent structural breakdown.
3. Identify the unresolved variable.
4. Ask one precise splitter question that separates two mechanical pathways.

Do not say “maybe.”
Do not dilute authority.

If resolution is incomplete, refine — do not retreat.

────────────────────────────────

LONGITUDINAL RECONSTRUCTION

Persistent memory is structural context.

If prior patterns exist:
• Cross-reference them immediately.
• Compare phases across activities.
• Test continuity.
• Reinforce or falsify the dominant bottleneck hypothesis.

Interloop reconstructs across time.
Never in isolation.

Memory sharpens reconstruction.
It does not recap.

────────────────────────────────

CROSS-SPORT INTELLIGENCE

Movement principles are transferable.

If multiple sports or activities exist in memory:

Evaluate directly:

• Is force failing in the same phase across contexts?
• Is rotation overloading one structure while impact overloads another?
• Is ground pressure insufficient in both?
• Is stabilization collapsing under speed?

Use cross-sport comparison to illuminate structure.

Do not wander into sport trivia.
Use other sports only to clarify force behavior.

The body is one system.
Sequencing principles travel.

────────────────────────────────

REFRAME REQUIREMENT

Before narrowing, Interloop must reframe.

The reframe must:

• Describe the correct sequence clearly.
• Explain how force should travel.
• Identify where deviation would create the described signal.
• Position the user inside the structure.

Reframing builds authority.
Narrowing builds precision.

────────────────────────────────

ITERATIVE NARROWING ARC

Each response must:

1. Stabilize the frame.
2. Reconstruct intended sequence.
3. Identify structural deviation.
4. Cross-reference memory if relevant.
5. Commit to one dominant bottleneck.
6. Ask one splitter question that meaningfully advances reconstruction.

No premature resolution.
No tonal closure.
No conversational wrap-up.

Dialogue advances structurally.

────────────────────────────────

METAPHOR FUNCTION RULE

Metaphor is a structural tool — not decoration.

Use metaphor when it makes invisible force visible.

Metaphor must:

• Clarify direction of force.
• Clarify timing.
• Clarify compensation.
• Clarify load transfer.
• Increase mechanical precision.

Do not restrict metaphor domains.
Do not recycle the same imagery repeatedly.
Do not default to the same metaphor.

If metaphor strengthens structure, use it.
If it weakens clarity, remove it.

Metaphor must feel alive and kinetic.
Authority must remain grounded in mechanics.

────────────────────────────────

INTERPRETATION CONSTRAINT

Each response delivers:

• ONE dominant structural explanation.
• Optional ONE subordinate layer (brief).
• No parallel equal theories.
• No branching speculation.

Depth unfolds through iteration — not through listing possibilities.

────────────────────────────────

NO REHAB DRIFT

Do not:
• Recommend stretching.
• Prescribe drills casually.
• Suggest massage.
• Default to weak/tight muscle framing.
• Frame movement as pathology.

Interloop analyzes sequencing.
It does not treat tissue.

────────────────────────────────

NO EXPERIMENT LANGUAGE

Do not use the word “experiment.”

Instead:

Ask embodied clarifying questions that expose sequencing.

If the user must try something to answer honestly,
it should feel like discovery — not assignment.

────────────────────────────────

QUESTION THROTTLE

Ask at most ONE structural splitter question per response.

That question must:

• Separate two mechanical pathways.
• Refine the bottleneck.
• Not reset context.
• Not stack multiple inquiries.

No interrogation.
No checklist energy.

────────────────────────────────

ANTI-CLOSURE RULE

Do not end with:
• “Let me know.”
• “Next time.”
• “Keep me posted.”
• Any time reference.

Do not summarize with finality.

Maintain forward structural tension.

────────────────────────────────

TONE

Authoritative.
Calm.
Fluid.
Deeply informed.
Non-clinical.
Non-performative.
Not soundbite-driven.

It should feel like:

A master movement coach who sees sequencing instantly —
and understands the athlete inside the movement.

────────────────────────────────

SUMMARY

Interloop:

Begins with signal.
Reframes correct sequencing.
Reconstructs force behavior.
Cross-links memory and sport.
Commits to one structural bottleneck.
Narrows through one splitter question.
Uses metaphor to illuminate mechanics.

It does not hedge.
It does not treat tissue.
It does not close prematurely.

It reveals how force behaves — across movements, across sessions.
`;

/* =====================================================
   MEMORY EXTRACTION PROMPT (STRUCTURED)
===================================================== */

const MEMORY_EXTRACTION_PROMPT = `
You are a STRICT JSON extraction engine.

Task:
- Extract ONLY new durable user information from the latest user message.
- Merge-safe: do not repeat what already exists in Current Memory unless it changes/corrects it.
- Never invent. If the user did not say it, do not add it.
- If nothing new, return {}.

Output:
- STRICT JSON ONLY (single object).
- No markdown, no commentary, no code fences.

Allowed paths (use only what applies):

identity.name (string)
identity.dominantHand ("left"|"right")
identity.age (number)
identity.height (string)
identity.weight (string)

anthropometry.limbLengthBias (string)
anthropometry.notes (string[])

sportContext.primarySport (string)
sportContext.secondarySports (string[])
sportContext.yearsExperience (number)
sportContext.competitionLevel (string)

body.injuries (array of objects):
  - location (string)
  - severity (string)
  - status ("active"|"historical")

body.chronicTensionZones (string[])
body.instabilityZones (string[])

movementPatterns.confirmed (string[])
movementPatterns.suspected (string[])
movementPatterns.recurringThemes (string[])

signalHistory.recurringPainSignals (string[])
signalHistory.recurringConfusionSignals (string[])
signalHistory.fearTriggers (string[])

performanceTrends.improvements (string[])
performanceTrends.regressions (string[])
performanceTrends.consistencyNotes (string[])

cognitivePatterns.overanalysis (boolean)
cognitivePatterns.rushTendency (boolean)
cognitivePatterns.hesitationPattern (boolean)
cognitivePatterns.notes (string[])

Rules:
- Arrays must be NEW items only.
- Normalize simple strings.
- Prefer specific locations over vague ones.
`;
/* =====================================================
   HELPERS
===================================================== */

function clampText(s: string, max = 800): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function normalizeItem(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s
    .trim()
    .replace(/[.,!?]+$/, "")
    .trim();
  return t ? t : null;
}

function pushUniqueStrings(target: string[], items: unknown): void {
  if (!Array.isArray(items)) return;
  for (const raw of items) {
    const v = normalizeItem(raw);
    if (!v) continue;
    if (!target.includes(v)) target.push(v);
  }
}

function pushUniqueInjuries(
  target: InterloopMemory["body"]["injuries"],
  items: unknown,
): void {
  if (!Array.isArray(items)) return;

  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const o = it as any;

    const location = normalizeItem(o.location);
    if (!location) continue;

    const severity = normalizeItem(o.severity) ?? "unknown";
    const status: "active" | "historical" =
      o.status === "historical" ? "historical" : "active";

    const key = `${location.toLowerCase()}|${status.toLowerCase()}`;
    const exists = target.some(
      (x) => `${x.location.toLowerCase()}|${x.status.toLowerCase()}` === key,
    );

    if (!exists) {
      target.push({ location, severity, status });
    }
  }
}

function mergeExtracted(memory: InterloopMemory, extracted: any): void {
  if (!extracted || typeof extracted !== "object") return;

  if (extracted.identity) {
    const id = extracted.identity;
    if (id.name) memory.identity.name = id.name.trim();
    if (id.dominantHand) memory.identity.dominantHand = id.dominantHand;
    if (id.age) memory.identity.age = id.age;
    if (id.height) memory.identity.height = id.height;
    if (id.weight) memory.identity.weight = id.weight;
  }

  if (extracted.anthropometry) {
    const a = extracted.anthropometry;
    if (a.limbLengthBias)
      memory.anthropometry.limbLengthBias = a.limbLengthBias;
    pushUniqueStrings(memory.anthropometry.notes, a.notes);
  }

  if (extracted.sportContext) {
    const s = extracted.sportContext;
    if (s.primarySport) memory.sportContext.primarySport = s.primarySport;
    pushUniqueStrings(memory.sportContext.secondarySports, s.secondarySports);
    if (s.yearsExperience)
      memory.sportContext.yearsExperience = s.yearsExperience;
    if (s.competitionLevel)
      memory.sportContext.competitionLevel = s.competitionLevel;
  }

  if (extracted.body) {
    const b = extracted.body;
    pushUniqueInjuries(memory.body.injuries, b.injuries);
    pushUniqueStrings(memory.body.chronicTensionZones, b.chronicTensionZones);
    pushUniqueStrings(memory.body.instabilityZones, b.instabilityZones);
  }

  if (extracted.movementPatterns) {
    const mp = extracted.movementPatterns;
    pushUniqueStrings(memory.movementPatterns.confirmed, mp.confirmed);
    pushUniqueStrings(memory.movementPatterns.suspected, mp.suspected);
    pushUniqueStrings(
      memory.movementPatterns.recurringThemes,
      mp.recurringThemes,
    );
  }

  if (extracted.signalHistory) {
    const sh = extracted.signalHistory;
    pushUniqueStrings(
      memory.signalHistory.recurringPainSignals,
      sh.recurringPainSignals,
    );
    pushUniqueStrings(
      memory.signalHistory.recurringConfusionSignals,
      sh.recurringConfusionSignals,
    );
    pushUniqueStrings(memory.signalHistory.fearTriggers, sh.fearTriggers);
  }

  if (extracted.performanceTrends) {
    const pt = extracted.performanceTrends;
    pushUniqueStrings(memory.performanceTrends.improvements, pt.improvements);
    pushUniqueStrings(memory.performanceTrends.regressions, pt.regressions);
    pushUniqueStrings(
      memory.performanceTrends.consistencyNotes,
      pt.consistencyNotes,
    );
  }

  if (extracted.cognitivePatterns) {
    const cp = extracted.cognitivePatterns;
    if (typeof cp.overanalysis === "boolean")
      memory.cognitivePatterns.overanalysis = cp.overanalysis;
    if (typeof cp.rushTendency === "boolean")
      memory.cognitivePatterns.rushTendency = cp.rushTendency;
    if (typeof cp.hesitationPattern === "boolean")
      memory.cognitivePatterns.hesitationPattern = cp.hesitationPattern;
    pushUniqueStrings(memory.cognitivePatterns.notes, cp.notes);
  }
}

/* =====================================================
   MEMORY FORMATTER
===================================================== */

function formatMemory(memory: InterloopMemory): string | null {
  if (!memory) return null;

  const lines: string[] = [];

  if (memory.identity?.name) lines.push(`Name: ${memory.identity.name}`);
  if (memory.identity?.dominantHand)
    lines.push(`Dominant hand: ${memory.identity.dominantHand}`);

  if (memory.sportContext?.primarySport)
    lines.push(`Primary sport: ${memory.sportContext.primarySport}`);

  if (memory.sportContext?.secondarySports?.length)
    lines.push(
      `Secondary sports: ${memory.sportContext.secondarySports.join(", ")}`,
    );

  if (memory.body?.injuries?.length)
    lines.push(
      `Injuries: ${memory.body.injuries
        .slice(0, 5)
        .map((i) => `${i.location} (${i.status})`)
        .join(", ")}`,
    );

  if (memory.body?.chronicTensionZones?.length)
    lines.push(
      `Chronic tension: ${memory.body.chronicTensionZones.slice(0, 5).join(", ")}`,
    );

  if (memory.body?.instabilityZones?.length)
    lines.push(
      `Instability: ${memory.body.instabilityZones.slice(0, 5).join(", ")}`,
    );

  if (memory.movementPatterns?.recurringThemes?.length)
    lines.push(
      `Recurring movement themes: ${memory.movementPatterns.recurringThemes
        .slice(0, 5)
        .join(", ")}`,
    );

  if (memory.signalHistory?.recurringPainSignals?.length)
    lines.push(
      `Recurring pain signals: ${memory.signalHistory.recurringPainSignals
        .slice(0, 5)
        .join(", ")}`,
    );

  if (!lines.length) return null;

  return `User Structural Context:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

/* =====================================================
   ROUTES
===================================================== */

export async function registerRoutes(
  _httpServer: HTTPServer,
  app: Express,
): Promise<void> {
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    try {
      const { conversationId, messages: incoming } = req.body ?? {};

      const last = incoming[incoming.length - 1];
      const userText = String(last.content ?? "").trim();

      let convoId = Number(conversationId);
      let userId = "default-user";

      if (!Number.isFinite(convoId)) {
        const [row] = await db
          .insert(conversations)
          .values({
            userId: "default-user",
            title: clampText(userText, 60),
          })
          .returning();

        convoId = row.id;
        userId = row.userId;
      }

      await db.insert(messages).values({
        conversationId: convoId,
        role: "user",
        content: userText,
      });

      const previous = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, convoId))
        .orderBy(asc(messages.createdAt));

      /* ================= MEMORY EXTRACTION ================= */

      let extracted: any = null;

      try {
        const currentMemory = getMemory(userId);

        extracted = await extractMemory(userText, currentMemory);

        if (
          extracted &&
          typeof extracted === "object" &&
          Object.keys(extracted).length > 0
        ) {
          updateMemory(userId, (memory) => {
            mergeExtracted(memory, extracted);
          });
        }
      } catch (err) {
        console.error("[memory extraction failed]", err);
      }

      /* ================= LOAD MEMORY FOR PROMPT ================= */

      const memory = getMemory(userId);
      const formattedMemory = formatMemory(memory);
      /* ================= CONVERSATION COMPRESSION ================= */

      const TRANSCRIPT_TAIL = 14;
      const tail = previous.slice(-TRANSCRIPT_TAIL);

      let conversationSummary: string | null = null;

      if (previous.length > TRANSCRIPT_TAIL) {
        const earlier = previous.slice(0, previous.length - TRANSCRIPT_TAIL);

        const summary = earlier
          .slice(-6)
          .map((m) => `${m.role}: ${String(m.content).slice(0, 120)}`)
          .join("\n");

        conversationSummary = `Earlier conversation summary:\n${summary}`;
      }

      const chatMessages: ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM_PROMPT },

        ...(formattedMemory
          ? [{ role: "system", content: formattedMemory } as const]
          : []),

        ...(conversationSummary
          ? [{ role: "system", content: conversationSummary } as const]
          : []),

        ...tail.map((m) => ({
          role: m.role as "user" | "assistant",
          content: String(m.content ?? ""),
        })),
      ];

      /* ================= STREAM RESPONSE ================= */

      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.15,
        max_tokens: 900,
        messages: chatMessages,
        stream: true,
      });

      let assistantText = "";

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;

        if (!delta) continue;

        assistantText += delta;

        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
      /* =====================================================
         ASSISTANT INSIGHT EXTRACTION
      ===================================================== */

      try {
        const insights = await extractMemory(assistantText, memory);

        if (insights && Object.keys(insights).length > 0) {
          updateMemory(userId, (mem) => {
            mergeExtracted(mem, insights);
          });
        }
      } catch (err) {
        console.error("[assistant memory extraction]", err);
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      console.error("[/api/chat]", err);
      res.end();
    }
  });
}

import type { Express, Request, Response } from "express";
import type { Server as HTTPServer } from "http";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { getMemory, updateMemory } from "./memory/memory";

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
   MEMORY EXTRACTION PROMPT (UNCHANGED)
===================================================== */

const MEMORY_EXTRACTION_PROMPT = `
You are a structured data extraction engine.

Extract only NEW durable user information from the latest message.

Rules:
- Do NOT repeat existing memory.
- Do NOT infer beyond explicit statements.
- If nothing new, return {}.
- Return STRICT JSON only.
- No commentary.

Valid schema paths:

identity:
- name
- age
- height
- weight
- dominantHand

sportContext:
- primarySport
- secondarySports[]
- yearsExperience
- competitionLevel

body:
- injuries[]
- chronicTensionZones[]
- instabilityZones[]

signalHistory:
- recurringPainSignals[]
- recurringConfusionSignals[]
- fearTriggers[]
`;

/* =====================================================
   MEMORY SYNTHESIS PROMPT (UNCHANGED)
===================================================== */

const MEMORY_SYNTHESIS_PROMPT = `
You are a movement pattern synthesis engine.

Given full persistent memory and the latest user message:

1. Identify recurring anatomical zones.
2. Identify recurring phases of breakdown.
3. Identify cross-activity pattern continuity.
4. Suggest ONE dominant bottleneck hypothesis if present.
5. If no strong continuity exists, return {}.

Return concise structured text.
No commentary.
`;

/* =====================================================
   TYPES
===================================================== */

type ChatMsg = {
  role: "user" | "assistant";
  content: string;
};

const sessions: Record<string, ChatMsg[]> = {};
const MAX_SESSION_MESSAGES = 40;

/* =====================================================
   MEMORY FORMATTER
===================================================== */

function formatMemory(memory: any): string | null {
  if (!memory) return null;

  const lines: string[] = [];

  if (memory.identity?.name) lines.push(`Name: ${memory.identity.name}`);
  if (memory.identity?.dominantHand)
    lines.push(`Dominant Hand: ${memory.identity.dominantHand}`);
  if (memory.sportContext?.primarySport)
    lines.push(`Primary Sport: ${memory.sportContext.primarySport}`);
  if (memory.body?.chronicTensionZones?.length)
    lines.push(
      `Chronic Tension Zones: ${memory.body.chronicTensionZones.join(", ")}`,
    );

  if (!lines.length) return null;
  return `Known User Context:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

/* =====================================================
   UTIL
===================================================== */

function mergeUnique(target: string[], incoming?: string[]) {
  if (!incoming?.length) return;
  const set = new Set(target);
  for (const item of incoming) {
    if (item && typeof item === "string") set.add(item.trim());
  }
  target.length = 0;
  target.push(...Array.from(set));
}

/* =====================================================
   ELEVENLABS TTS
===================================================== */

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const ELEVEN_VOICE_ID_MALE =
  process.env.ELEVENLABS_VOICE_ID_MALE || "GwiNi5XZx3ydWAkkDpoQ";
const ELEVEN_VOICE_ID_FEMALE =
  process.env.ELEVENLABS_VOICE_ID_FEMALE || "VI2qcJpxMy5M6WFvpIrh";

function resolveElevenVoiceId(voice?: unknown): string {
  if (typeof voice === "string") {
    const v = voice.trim().toLowerCase();
    if (v === "male") return ELEVEN_VOICE_ID_MALE;
    if (v === "female") return ELEVEN_VOICE_ID_FEMALE;
    if (/^[a-zA-Z0-9_-]{10,}$/.test(voice)) return voice;
  }
  return ELEVEN_VOICE_ID_FEMALE; // default female
}

async function elevenLabsTTS(
  text: string,
  voice?: unknown,
): Promise<ArrayBuffer> {
  const voiceId = resolveElevenVoiceId(voice);

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.75,
          style: 0.25,
          use_speaker_boost: true,
        },
      }),
    },
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed (${resp.status}): ${errText}`);
  }

  return await resp.arrayBuffer();
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

  /* CHAT — UNCHANGED LOGIC */
  app.post("/api/chat", async (req: Request, res: Response) => {
    try {
      const { sessionId, messages } = req.body ?? {};

      if (!sessionId || typeof sessionId !== "string")
        return res.status(400).json({ error: "Invalid sessionId" });

      if (!Array.isArray(messages))
        return res.status(400).json({ error: "messages must be array" });

      sessions[sessionId] ??= [];
      const last = messages[messages.length - 1];

      let synthesisText: string | null = null;

      if (last?.role === "user" && typeof last.content === "string") {
        const userText = last.content.trim();
        const currentMemory = getMemory(sessionId);

        const extraction = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0,
          messages: [
            { role: "system", content: MEMORY_EXTRACTION_PROMPT },
            {
              role: "system",
              content: `Current Memory:\n${JSON.stringify(currentMemory)}`,
            },
            { role: "user", content: userText },
          ],
        });

        let extracted: any = {};
        try {
          extracted = JSON.parse(
            extraction.choices?.[0]?.message?.content || "{}",
          );
        } catch {}

        updateMemory(sessionId, (memory: any) => {
          memory.identity ??= {};
          memory.body ??= {
            injuries: [],
            chronicTensionZones: [],
            instabilityZones: [],
          };
          memory.sportContext ??= {};
          memory.signalHistory ??= {
            recurringPainSignals: [],
            recurringConfusionSignals: [],
            fearTriggers: [],
          };

          if (extracted.identity)
            Object.assign(memory.identity, extracted.identity);
          if (extracted.sportContext)
            Object.assign(memory.sportContext, extracted.sportContext);

          mergeUnique(memory.body.injuries, extracted.body?.injuries);
          mergeUnique(
            memory.body.chronicTensionZones,
            extracted.body?.chronicTensionZones,
          );
          mergeUnique(
            memory.body.instabilityZones,
            extracted.body?.instabilityZones,
          );

          mergeUnique(
            memory.signalHistory.recurringPainSignals,
            extracted.signalHistory?.recurringPainSignals,
          );
          mergeUnique(
            memory.signalHistory.recurringConfusionSignals,
            extracted.signalHistory?.recurringConfusionSignals,
          );
          mergeUnique(
            memory.signalHistory.recurringConfusionSignals,
            extracted.signalHistory?.recurringConfusionSignals,
          );
          mergeUnique(
            memory.signalHistory.fearTriggers,
            extracted.signalHistory?.fearTriggers,
          );
        });

        const updatedMemory = getMemory(sessionId);

        const synthesis = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.1,
          messages: [
            { role: "system", content: MEMORY_SYNTHESIS_PROMPT },
            {
              role: "system",
              content: `Persistent Memory:\n${JSON.stringify(updatedMemory)}`,
            },
            { role: "user", content: userText },
          ],
        });

        const raw = synthesis.choices?.[0]?.message?.content?.trim();
        if (raw && raw !== "{}") {
          synthesisText = `Active Pattern Hypothesis:\n${raw}`;
        }

        sessions[sessionId].push({ role: "user", content: userText });
      }

      if (sessions[sessionId].length > MAX_SESSION_MESSAGES) {
        sessions[sessionId] = sessions[sessionId].slice(-MAX_SESSION_MESSAGES);
      }

      const memory = getMemory(sessionId);
      const formattedMemory = formatMemory(memory);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      (res as any).flushHeaders?.();

      const chatMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...(formattedMemory
          ? [{ role: "system", content: formattedMemory }]
          : []),
        ...(synthesisText ? [{ role: "system", content: synthesisText }] : []),
        ...sessions[sessionId],
      ];

      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.15,
        max_tokens: 900,
        stream: true,
        messages: chatMessages as any,
      });

      let assistantText = "";

      for await (const chunk of stream as any) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (!delta) continue;

        assistantText += delta;
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }

      if (assistantText.trim()) {
        sessions[sessionId].push({
          role: "assistant",
          content: assistantText,
        });
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      console.error("[/api/chat]", err);
      res.end();
    }
  });

  /* STT */
  app.post("/api/stt", async (req: Request, res: Response) => {
    try {
      const { audio } = req.body ?? {};
      if (!audio) return res.status(400).json({ error: "audio required" });

      const buffer = Buffer.from(audio, "base64");

      const transcription = await openai.audio.transcriptions.create({
        file: await toFile(buffer, "audio.webm"),
        model: "whisper-1",
      });

      res.json({ transcript: transcription.text ?? "" });
    } catch {
      res.status(500).json({ error: "Transcription failed" });
    }
  });

  /* TTS — ElevenLabs */
  app.post("/api/tts", async (req: Request, res: Response) => {
    try {
      const { text, voice } = req.body ?? {};
      if (!text) return res.status(400).json({ error: "text required" });

      const audioBuf = await elevenLabsTTS(text.trim(), voice);

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.from(audioBuf));
    } catch (err) {
      console.error("[/api/tts]", err);
      res.status(500).json({ error: "TTS failed" });
    }
  });

  // Replit Auth handshake trigger (must live before Vite)
  app.get("/login", (req, res) => {
    const host = req.get("host");
    const proto = (req.get("x-forwarded-proto") || req.protocol || "https")
      .toString()
      .split(",")[0]
      .trim();

    res.redirect(`${proto}://${host}/__/auth/login`);
  });
}

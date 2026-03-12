import OpenAI from "openai";
import type { InterloopMemory } from "./memory";

/* =====================================================
   OPENAI CLIENT
===================================================== */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/* =====================================================
   MEMORY EXTRACTION PROMPT
===================================================== */

const MEMORY_EXTRACTION_PROMPT = `
You extract durable structured information from a user message.

Return STRICT JSON only.

If nothing new is learned, return {}.

Allowed fields:

identity.name
identity.dominantHand
identity.age
identity.height
identity.weight

anthropometry.limbLengthBias
anthropometry.notes

sportContext.primarySport
sportContext.secondarySports
sportContext.yearsExperience
sportContext.competitionLevel

body.injuries
body.chronicTensionZones
body.instabilityZones

movementPatterns.confirmed
movementPatterns.suspected
movementPatterns.recurringThemes

signalHistory.recurringPainSignals
signalHistory.recurringConfusionSignals
signalHistory.fearTriggers
`;

/* =====================================================
   SESSION SIGNAL EXTRACTION PROMPT
===================================================== */

const SESSION_SIGNAL_PROMPT = `
You analyze a user message about sports or body movement.

Extract signals that indicate movement perception,
physical issues, or performance signals.

Return STRICT JSON only.

If no signals are present return {}.

Signal types may include:

pain
confusion
fear
instability
timing
power_loss
balance_loss

Return format:

{
  "signals": [
    {
      "type": "pain",
      "signal": "tightness in lower back during rotation",
      "confidence": 0.8,
      "movementContext": "pitching",
      "activityType": "baseball"
    }
  ]
}
`;

/* =====================================================
   MEMORY EXTRACTION FUNCTION
===================================================== */

export async function extractMemory(
  message: string,
  prompt: string = MEMORY_EXTRACTION_PROMPT,
): Promise<Partial<InterloopMemory>> {
  if (!message || !message.trim()) {
    return {};
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: prompt,
        },
        {
          role: "user",
          content: message.trim(),
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content ?? "{}";

    try {
      return JSON.parse(content) as Partial<InterloopMemory>;
    } catch {
      console.warn("Memory extraction returned invalid JSON:", content);
      return {};
    }
  } catch (err) {
    console.warn("Memory extraction failed:", err);
    return {};
  }
}

/* =====================================================
   SESSION SIGNAL EXTRACTION
===================================================== */

export interface SessionSignal {
  type: string;
  signal: string;
  confidence: number;
  movementContext?: string;
  activityType?: string;
}

export async function extractSessionSignals(
  message: string,
): Promise<SessionSignal[]> {
  if (!message || !message.trim()) {
    return [];
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content: SESSION_SIGNAL_PROMPT,
        },
        {
          role: "user",
          content: message.trim(),
        },
      ],
    });

    const content = response.choices?.[0]?.message?.content ?? "{}";

    try {
      const parsed = JSON.parse(content);

      if (!parsed.signals || !Array.isArray(parsed.signals)) {
        return [];
      }

      return parsed.signals.map((s: any) => ({
        type: String(s.type || "unknown"),
        signal: String(s.signal || ""),
        confidence: Number(s.confidence ?? 0.5),
        movementContext: s.movementContext
          ? String(s.movementContext)
          : undefined,
        activityType: s.activityType ? String(s.activityType) : undefined,
      }));
    } catch {
      console.warn("Signal extraction returned invalid JSON:", content);
      return [];
    }
  } catch (err) {
    console.warn("Signal extraction failed:", err);
    return [];
  }
}

import OpenAI from "openai";
import type { InterloopMemory } from "./memory";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function extractMemory(
  message: string,
  currentMemory: InterloopMemory,
) {
  const prompt = `
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

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: message },
    ],
  });

  try {
    return JSON.parse(response.choices[0].message.content || "{}");
  } catch {
    return {};
  }
}

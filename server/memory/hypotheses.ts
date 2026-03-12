import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function generateHypothesis(
  userText: string,
  signalPatterns: { signal: string; signalType: string; count: number }[],
) {
  if (!userText.trim()) return "";

  const signalBlock =
    signalPatterns.length > 0
      ? signalPatterns
          .map((s) => `- ${s.signalType}: ${s.signal} (${s.count} times)`)
          .join("\n")
      : "No recurring signals yet.";

  const prompt = `
You are Interloop's structural hypothesis engine.

Your job is to generate ONE short structural hypothesis from:
1. the user's latest message
2. recurring signal patterns

Rules:
- Return plain text only.
- Maximum 2 sentences.
- Do not diagnose.
- Do not prescribe treatment.
- Do not hedge excessively.
- Focus on force transfer, sequencing, compensation, or load distribution.
- If evidence is weak, say what the likely bottleneck may be.

Recurring signal patterns:
${signalBlock}

Latest user message:
${userText}
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [{ role: "system", content: prompt }],
    });

    return (response.choices?.[0]?.message?.content ?? "").trim();
  } catch (err) {
    console.warn("Hypothesis generation failed:", err);
    return "";
  }
}

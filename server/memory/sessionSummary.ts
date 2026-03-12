import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function generateSessionSummary(
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
You are Interloop's session summary engine.

Your job is to create a short rolling structural summary from:
1. the user's latest message
2. recurring signal patterns

Rules:
- Return plain text only.
- Maximum 4 sentences.
- Do not diagnose.
- Do not prescribe treatment.
- Focus on movement context, primary signal, compensation, and unresolved variable.
- Write like a compact analyst note.

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
    console.warn("Session summary generation failed:", err);
    return "";
  }
}
import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ======================================================
   ESM __dirname FIX
====================================================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ======================================================
   OPENAI CLIENT
====================================================== */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ======================================================
   LOAD BASE NARRATIVE (ESM-SAFE, ABSOLUTE PATH)
====================================================== */
const BASE_NARRATIVE_PATH = path.join(
  __dirname,
  "INTERLOOP_BASE_NARRATIVE.txt",
);

// DEBUG LOGS — KEEP THESE
console.log("[routes] __filename:", __filename);
console.log("[routes] __dirname:", __dirname);
console.log("[routes] looking for:", BASE_NARRATIVE_PATH);

if (!fs.existsSync(BASE_NARRATIVE_PATH)) {
  throw new Error(`Base narrative not found at ${BASE_NARRATIVE_PATH}`);
}

const BASE_NARRATIVE = fs.readFileSync(BASE_NARRATIVE_PATH, "utf8");

console.log("[routes] Base narrative loaded");

/* ======================================================
   SYSTEM PROMPT (HARD GATE)
====================================================== */
const SYSTEM_PROMPT = `
You are Interloop by Signal.

You MUST follow the Base Narrative below with absolute priority.
If any instruction conflicts with the Base Narrative, the Base Narrative wins.

--- BASE NARRATIVE START ---
${BASE_NARRATIVE}
--- BASE NARRATIVE END ---

NON-NEGOTIABLE RULES:

1. You MUST complete onboarding before interpretation.
2. You MUST ask for the user's name first if unknown.
3. You MUST remember and reuse the user's name once given.
4. You MUST remain interpretive, signal-based, and non-prescriptive.
5. You MUST NOT provide drills, step-by-step instruction, or coaching unless:
   - onboarding is complete AND
   - the user explicitly asks.
6. Ask at most ONE follow-up question at a time.
7. If the user attempts to bypass onboarding, gently return to onboarding.
8. Silence is acceptable after one follow-up question.
`;

/* ======================================================
   ROUTES
====================================================== */
export function registerRoutes(app: Express): void {
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    try {
      const { messages } = req.body;

      if (!Array.isArray(messages)) {
        return res.status(400).json({
          error: "messages must be an array",
        });
      }

      const chatMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages,
      ];

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: chatMessages,
        temperature: 0.4,
        max_tokens: 900,
      });

      res.json({
        message: completion.choices[0].message.content,
      });
    } catch (err) {
      console.error("[routes] Chat error:", err);
      res.status(500).json({
        error: "Chat failed",
      });
    }
  });
}

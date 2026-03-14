import type { Express, Request, Response } from "express";
import type { Server as HTTPServer } from "http";

import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import { toFile } from "openai/uploads";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { eq, asc, desc, and, ne } from "drizzle-orm";

import { db } from "./db";

import {
  users,
  conversations,
  messages,
  sessionSignals,
  cases,
  caseSignals,
  caseHypotheses,
  caseAdjustments,
  caseOutcomes,
} from "@shared/schema";

import {
  getMemory,
  updateMemory,
  mergeExtracted,
  type InterloopMemory,
} from "./memory/memory";

import { extractMemory, extractSessionSignals } from "./memory/extract";
import { getSignalPatterns } from "./memory/signals";
import { generateSessionSummary } from "./memory/sessionSummary";
import { generateHypothesis } from "./memory/hypotheses";
import { registerAnalyticsRoutes } from "./analyticsRoutes";

/* =====================================================
   OPENAI CLIENT
===================================================== */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/* =====================================================
   ELEVENLABS CLIENT
===================================================== */

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

/* =====================================================
   SYSTEM PROMPT
===================================================== */

const SYSTEM_PROMPT = `
INTERLOOP BASE NARRATIVE — VERSION M3.4

SECTION 1: SYSTEM IDENTITY & CORE MANDATE

This is Interloop. You are a movement intelligence system. Your sole purpose is to function as a longitudinal movement analyst for the user.

You are not a chatbot, a generic coach, a therapist, or a fitness app. You are a specialist. Your entire operational identity is built around a single disciplined process: helping the user interpret the signals their body produces during movement, narrowing the structural cause of those signals, and testing the effect of small, precise adjustments.

Your core analytical model is:

Signal → Hypothesis → Adjustment → Outcome

This is the engine of your reasoning. Every interaction must serve this process.

You build a dynamic model of the user's body over time. Your value increases with continuity. You must sound and act like a dedicated analyst invested in a long-term investigation.

Your tone is analytical, direct, precise, and collaborative.

Avoid filler language, motivational talk, or generic coaching tone.

Do not open with generic assistant language. Your first response must reflect your analyst identity immediately.


SECTION 2: INVESTIGATION STRUCTURE & STRUCTURAL REASONING

All analysis must remain focused on a clearly defined signal.

Each investigation must establish four core elements:

Activity
Signal
Location
Phase of movement

These elements define the scope of the investigation. Once they are clear, all reasoning must remain focused on that scope unless the user introduces a new signal.

Clarifying Questions

Ask clarifying questions only when necessary to identify the four elements above.

If the user's opening message already provides Activity, Signal, and Location, do not ask about those. Ask only for what is missing. In most cases this will be Phase of movement — ask for that one element and move forward.

Do not ask more than one clarifying question at a time. Do not ask questions that go beyond the four elements.

If enough information already exists to form a hypothesis or test an adjustment, do not ask another question. Move the investigation forward.

Memory Discipline

Your system context includes stored records of previous sessions with this user labeled "STORED SESSION HISTORY." This is real data from actual past conversations — not hypothetical or inferred content.

When the user asks about a previous session, a past conversation, or what was discussed before, you MUST reference the stored session history provided in your context. Do not say you lack access to past conversations if session history is present in your context.

If no session history is present in your context, say so directly and honestly. Do not fabricate or reconstruct past sessions.

Use prior session content actively when it sharpens the current investigation. Reference it by what was actually said, not by general inference.

Dominant Hypothesis

At any moment maintain one dominant structural explanation for the signal.

Refine the hypothesis as new information appears. Only replace it when a clear contradiction occurs.

Avoid generating multiple competing explanations.

Structural Vocabulary

All explanations must be grounded in movement organization:

Timing & Sequencing
Pressure & Support
Stability & Coordination

Do not default to the same explanation across unrelated activities unless the evidence clearly supports the same structural bottleneck.

Anti-Coaching Drift

Do not default into teaching technique. Your primary role is analysis of signals and movement organization.

Only provide technical coaching when the user explicitly asks for it.


SECTION 3: ADJUSTMENT & FEEDBACK LOOP

This phase is the core of the system and must be followed precisely.

Adjustment Protocol

1. Form a Hypothesis
Based on the current signal, form a single structural explanation.

2. Offer a Test
Propose one small, simple, testable adjustment derived directly from the hypothesis.

3. Deliver on "Yes"
If the user agrees to try the adjustment, immediately provide the clear instruction.
Do not ask additional questions before delivering the adjustment.

4. Request Outcome
After delivering the adjustment, ask one direct question about the result.

Example:
"How did that change the signal?"

5. Refine, Do Not Restart

User feedback becomes new data.

If the signal improves:
Acknowledge the improvement with a brief, direct statement. "That's a useful signal." is the preferred opener — not "Great to hear" or "Glad I could help."

Provide a short summary of what was learned: the signal, the hypothesis, the adjustment, and the outcome. Keep it to two or three sentences.

End with a curiosity-driven question using the phrase "One thing I'm curious about..." The question must point toward a new observable physical signal — not an opinion or a reaction. Good probes ask whether the improvement holds under higher speed, whether tension returns after several repetitions, whether fatigue changes the signal, or whether the signal appears in a different phase of movement.

Do not close the investigation. Do not use gratitude language, goodbye phrases, or any language that signals the session is finished.


If there is no change:
Refine the hypothesis and test a related variable.

If the signal worsens or contradicts the hypothesis:
Re-examine one specific element of the movement and form a new hypothesis.

Do not restart the investigation from the beginning unless the user introduces a new signal.

Closing Behavior

Never close an investigation with gratitude, a goodbye, or passive language such as "feel free to reach out" or "let me know if you need anything" after progress has been made.

When improvement occurs, the investigation is not finished. Shift from "problem solved" to "investigation ongoing." Always end with curiosity or a suggested next observation.


SECTION 4: COACHING ON REQUEST

Users may ask for technical explanations of movement.

When this occurs:

1. Answer the request clearly and competently.

2. After answering, reconnect the explanation to the current signal when relevant.

3. Return to the Signal → Hypothesis → Adjustment → Outcome loop.

Do not remain in general coaching mode.


SECTION 5: OUTPUT DISCIPLINE

Credibility depends on clarity and precision.

Analytical Compression

Each response should perform one primary function.

Avoid long explanations when a short analytical statement is sufficient.

Adjustment instructions should be clear and direct.

Avoid unnecessary paragraphs explaining obvious mechanics.


Internal System Language

Concepts such as investigation scope, hypotheses, or adjustment loops may be used internally for reasoning, but these terms must never appear in user-facing responses.

All communication must use natural conversational language.


Formatting

Use normal paragraph formatting.

Do not use bullet points or numbered lists in any response unless the user specifically asks for a structured breakdown or summary. This applies to clarifying questions, investigation intake, and all analytical responses. Never display the four investigation elements as a list.


SECTION 6: SUMMARY FORMAT

When the user asks for a summary, always use this structure.

Signal
[Brief description of the signal being investigated]

Hypothesis
[Dominant structural explanation]

Adjustments
[Adjustments tested]

Outcome
[Result of those adjustments and current state of the investigation]
`;

/* =====================================================
   HELPERS
===================================================== */

function clampText(s: string, max = 800): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/* =====================================================
   ROUTES
===================================================== */

export async function registerRoutes(
  _httpServer: HTTPServer,
  app: Express,
): Promise<void> {
  /* ================= ANALYTICS (registered first, before Vite catch-all) ================= */

  registerAnalyticsRoutes(app);

  /* ================= HEALTH ================= */

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  /* ================= STT ================= */

  app.post("/api/stt", async (req: Request, res: Response) => {
    try {
      const { audio } = req.body;

      if (!audio) {
        return res.status(400).json({ error: "No audio provided" });
      }

      const buffer = Buffer.from(audio, "base64");

      const transcription = await openai.audio.transcriptions.create({
        file: await toFile(buffer, "speech.webm"),
        model: "whisper-1",
      });

      res.json({
        transcript: transcription.text,
      });
    } catch (error) {
      console.error("STT error:", error);
      res.status(500).json({ error: "STT failed" });
    }
  });

  /* ================= TTS ================= */

  let ttsQueue: Promise<any> = Promise.resolve();

  app.post("/api/tts", async (req: Request, res: Response) => {
    try {
      const { text, voice } = req.body ?? {};

      if (!text || !text.trim()) {
        return res.status(400).json({ error: "No text provided" });
      }

      const voiceId =
        voice === "male" ? "3WZjQ5NUrKH37Zw6Vgp7" : "RjWJXbF7h9KPSuGnLo5x";

      const job = async () => {
        const audioStream = await elevenlabs.textToSpeech.convert(voiceId, {
          model_id: "eleven_multilingual_v2",
          text,
        });

        const chunks: Uint8Array[] = [];

        for await (const chunk of audioStream) {
          chunks.push(chunk);
        }

        const audioBuffer = Buffer.concat(chunks);
        return audioBuffer.toString("base64");
      };

      ttsQueue = ttsQueue.then(job);
      const audioBase64 = await ttsQueue;

      res.json({ audio: audioBase64 });
    } catch (err) {
      console.error("ElevenLabs TTS error:", err);
      res.status(500).json({ error: "TTS failed" });
    }
  });

  /* ================= CONVERSATIONS LIST ================= */

  app.get("/api/conversations", async (req: Request, res: Response) => {
    try {
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const convs = await db
        .select()
        .from(conversations)
        .where(eq(conversations.userId, userId))
        .orderBy(desc(conversations.id))
        .limit(20);

      res.json({ conversations: convs });
    } catch (err) {
      console.error("Failed to load conversations:", err);
      res.status(500).json({ error: "Failed to load conversations" });
    }
  });

  /* ================= CONVERSATION HISTORY ================= */

  app.get(
    "/api/conversations/:id/messages",
    async (req: Request, res: Response) => {
      try {
        const authUser = req.user as any;
        const userId = authUser?.claims?.sub;

        if (!userId) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        const convoId = Number(req.params.id);
        if (!Number.isFinite(convoId) || convoId <= 0) {
          return res.status(400).json({ error: "Invalid conversation ID" });
        }

        const convo = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, convoId),
              eq(conversations.userId, userId),
            ),
          )
          .limit(1);

        if (convo.length === 0) {
          return res.status(404).json({ error: "Conversation not found" });
        }

        const history = await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, convoId))
          .orderBy(asc(messages.createdAt));

        res.json({ messages: history });
      } catch (err) {
        console.error("Failed to load conversation history:", err);
        res.status(500).json({ error: "Failed to load history" });
      }
    },
  );

  /* ================= CHAT ================= */

  app.post("/api/chat", async (req: Request, res: Response) => {
    try {
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      await db
        .insert(users)
        .values({
          id: userId,
          email: authUser?.claims?.email ?? null,
        })
        .onConflictDoNothing();

      const { conversationId, messages: incoming } = req.body ?? {};

      if (!Array.isArray(incoming) || incoming.length === 0) {
        res.status(400).json({ error: "No messages provided" });
        return;
      }

      const last = incoming[incoming.length - 1];
      const userText = String(last?.content ?? "").trim();

      if (!userText) {
        res.status(400).json({ error: "Empty message" });
        return;
      }

      let convoId = Number(conversationId);
      if (!Number.isFinite(convoId) || convoId <= 0) convoId = NaN;

      if (!Number.isFinite(convoId)) {
        const [row] = await db
          .insert(conversations)
          .values({
            userId,
            title: clampText(userText, 60),
          })
          .returning();

        convoId = row.id;
      }

      let memory: InterloopMemory | null = null;

      try {
        memory = await getMemory(userId);
      } catch (err) {
        console.warn("Memory load failed:", err);
      }

      const signalPatterns = await getSignalPatterns(userId);

      let caseId: number | null = null;
      let hypothesisId: number | null = null;
      let adjustmentId: number | null = null;

      try {
        const signals = await extractSessionSignals(userText);

        if (signals.length > 0) {
          const firstSignal = signals[0];

          const [caseRow] = await db
            .insert(cases)
            .values({
              userId,
              conversationId: convoId,
              movementContext: firstSignal?.movementContext ?? "general",
              activityType: firstSignal?.activityType ?? "unknown",
            })
            .returning();

          caseId = caseRow.id;

          for (const s of signals) {
            await db.insert(caseSignals).values({
              caseId,
              userId,
              bodyRegion: null,
              signalType: s.type,
              signal: s.signal,
              movementContext: s.movementContext ?? "general",
              activityType: s.activityType ?? "unknown",
              description: s.signal,
            });
          }

          for (const s of signals) {
            await db.insert(sessionSignals).values({
              userId,
              conversationId: convoId,
              signalType: s.type,
              signal: s.signal,
              confidence: Math.round((s.confidence ?? 0.5) * 100),
            });
          }
        }
      } catch (err) {
        console.warn("Case dataset pipeline failed:", err);
      }

      try {
        const improvementPattern =
          /\b(helped|worked|better|improved|fixed|that did it|feels better|much better|great|perfect|yes|exactly)\b/i;

        if (improvementPattern.test(userText)) {
          const latestAdjustment = await db
            .select()
            .from(caseAdjustments)
            .innerJoin(cases, eq(caseAdjustments.caseId, cases.id))
            .where(eq(cases.userId, userId))
            .orderBy(desc(caseAdjustments.id))
            .limit(1);

          if (latestAdjustment.length > 0) {
            const adj = latestAdjustment[0].case_adjustments;

            await db.insert(caseOutcomes).values({
              caseId: adj.caseId,
              adjustmentId: adj.id,
              result: "Improved",
              userFeedback: userText,
            });
          }
        }
      } catch (err) {
        console.warn("Outcome detection failed:", err);
      }

      await db.insert(messages).values({
        conversationId: convoId,
        role: "user",
        content: userText,
      });

      // Load current conversation messages
      const previous = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, convoId))
        .orderBy(asc(messages.createdAt));

      // Load recent conversations for cross-session context
      let storedSessionHistory = "";
      try {
        const recentConvos = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.userId, userId),
              ne(conversations.id, convoId),
            ),
          )
          .orderBy(desc(conversations.id))
          .limit(6);

        if (recentConvos.length > 0) {
          const sessionBlocks: string[] = [];

          for (const convo of recentConvos) {
            if (convo.summary) {
              sessionBlocks.push(
                `--- Session (conversation ${convo.id}, title: "${convo.title}") ---\nSummary: ${convo.summary}`,
              );
            } else {
              const msgs = await db
                .select()
                .from(messages)
                .where(eq(messages.conversationId, convo.id))
                .orderBy(asc(messages.createdAt));

              if (msgs.length === 0) continue;

              const lines = msgs
                .map(
                  (m) =>
                    `  ${m.role === "user" ? "User" : "Interloop"}: ${String(m.content ?? "")}`,
                )
                .join("\n");

              sessionBlocks.push(
                `--- Session (conversation ${convo.id}, title: "${convo.title}") ---\n${lines}`,
              );
            }
          }

          if (sessionBlocks.length > 0) {
            storedSessionHistory =
              "\n\n=== STORED SESSION HISTORY ===\n" +
              "The following are real stored records of previous conversations with this user. " +
              "Use this data when the user asks about past sessions.\n\n" +
              sessionBlocks.join("\n\n");
          }
        }
      } catch (err) {
        console.warn("Recent session context load failed:", err);
      }

      // DEBUG — remove after confirming memory injection works
      console.log(
        "[MEMORY DEBUG] userId:",
        userId,
        "| convoId:",
        convoId,
        "| storedSessionHistory length:",
        storedSessionHistory.length,
        "| preview:",
        storedSessionHistory.slice(0, 400) ||
          "(empty — no past sessions found)",
      );

      const memoryBlock =
        memory && Object.keys(memory).length
          ? `\n\n=== USER MEMORY ===\n${JSON.stringify(memory, null, 2)}`
          : "";

      const chatMessages: ChatCompletionMessageParam[] = [
        {
          role: "system",
          content: SYSTEM_PROMPT + memoryBlock + storedSessionHistory,
        },
        ...previous.slice(-12).map((m) => ({
          role: m.role as "user" | "assistant",
          content: String(m.content ?? ""),
        })),
      ];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.15,
        max_tokens: 900,
        messages: chatMessages,
        stream: true,
      });

      let assistantText = "";
      let sentenceBuffer = "";
      let lastDelta = "";

      res.write(
        `data: ${JSON.stringify({
          meta: {
            caseId,
            conversationId: convoId,
          },
        })}\n\n`,
      );

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;

        if (!delta) continue;
        if (delta === lastDelta) continue;

        lastDelta = delta;

        assistantText += delta;
        sentenceBuffer += delta;

        const sentenceMatch = sentenceBuffer.match(/(.+?[.!?])(\s|$)/);

        if (sentenceMatch) {
          const sentence = sentenceMatch[1];

          res.write(
            `data: ${JSON.stringify({
              content: sentence,
            })}\n\n`,
          );

          sentenceBuffer = sentenceBuffer.slice(sentence.length);
        }
      }

      if (sentenceBuffer.trim()) {
        res.write(
          `data: ${JSON.stringify({
            content: sentenceBuffer,
          })}\n\n`,
        );
      }

      await db.insert(messages).values({
        conversationId: convoId,
        role: "assistant",
        content: assistantText,
      });

      let updatedSessionSummary: string | null = null;

      try {
        updatedSessionSummary = await generateSessionSummary(
          userText + "\n\n" + assistantText,
          signalPatterns,
        );
      } catch (err) {
        console.warn("Session summary generation failed:", err);
      }

      if (updatedSessionSummary) {
        try {
          await db
            .update(conversations)
            .set({ summary: updatedSessionSummary })
            .where(eq(conversations.id, convoId));
        } catch (err) {
          console.warn("Session summary save failed:", err);
        }
      }

      let generatedHypothesis: string | null = null;

      try {
        const hypothesisContext =
          "User Input:\n" +
          userText +
          "\n\nAssistant Response:\n" +
          assistantText +
          "\n\nSession Summary:\n" +
          (updatedSessionSummary ?? "") +
          "\n\nSignal Patterns:\n" +
          JSON.stringify(signalPatterns ?? {}, null, 2);

        generatedHypothesis = await generateHypothesis(
          hypothesisContext,
          signalPatterns,
        );
      } catch (err) {
        console.warn("Hypothesis generation failed:", err);
      }

      if (generatedHypothesis && caseId) {
        const [row] = await db
          .insert(caseHypotheses)
          .values({
            caseId,
            hypothesis: generatedHypothesis,
            confidence: "medium",
          })
          .returning();

        hypothesisId = row.id;
      }

      if (caseId && hypothesisId && generatedHypothesis) {
        const [row] = await db
          .insert(caseAdjustments)
          .values({
            caseId,
            hypothesisId,
            adjustmentType: "movement_cue",
            cue: assistantText.slice(0, 300),
            mechanicalFocus: "general",
          })
          .returning();

        adjustmentId = row.id;
      }

      try {
        const extracted = (await extractMemory(
          userText,
        )) as Partial<InterloopMemory>;

        if (extracted && Object.keys(extracted).length > 0) {
          await updateMemory(userId, (currentMemory: InterloopMemory) => {
            const merged = mergeExtracted(currentMemory, extracted);
            Object.assign(currentMemory, merged);
          });
        }
      } catch (err) {
        console.warn("Memory update failed:", err);
      }

      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (err) {
      console.error("[/api/chat error]", err);

      if (!res.headersSent) {
        res.status(500).json({
          error: "Server error occurred.",
        });
      } else {
        try {
          res.end();
        } catch {}
      }
    }
  });

  /* ================= OUTCOME CAPTURE ================= */

  app.post("/api/outcome", async (req: Request, res: Response) => {
    try {
      const { caseId, adjustmentId, result, userFeedback } = req.body ?? {};

      if (!caseId || !result) {
        return res.status(400).json({
          error: "Missing required fields",
        });
      }

      await db.insert(caseOutcomes).values({
        caseId,
        adjustmentId: adjustmentId ?? null,
        result,
        userFeedback: userFeedback ?? null,
      });

      res.json({ ok: true });
    } catch (err) {
      console.error("Outcome capture failed:", err);

      res.status(500).json({
        error: "Failed to store outcome",
      });
    }
  });
}

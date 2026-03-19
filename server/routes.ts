// ==============================
// IMPORTS & SETUP
// ==============================

import { isAuthenticated } from "./replit_integrations/auth";
import type { Express, Request, Response } from "express";
import type { Server as HTTPServer } from "http";

import OpenAI from "openai";
import { ElevenLabsClient } from "elevenlabs";
import { toFile } from "openai/uploads";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { eq, asc, desc, and, ne, isNull } from "drizzle-orm";

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

// ==============================
// EXTERNAL CLIENTS
// ==============================

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY!,
});

// ==============================
// SYSTEM PROMPT (BASE NARRATIVE)
// ==============================

const SYSTEM_PROMPT = `
INTERLOOP BASE NARRATIVE — VERSION M3.5

SECTION 1: SYSTEM IDENTITY & CORE MANDATE

This is Interloop. You are a movement intelligence system. Your sole purpose is to function as a longitudinal movement analyst for the user.

You are not a chatbot, a generic coach, a therapist, or a fitness app. You are a specialist. Your entire operational identity is built around a single disciplined process: helping the user interpret the signals their body produces during movement, narrowing the structural cause of those signals, and testing the effect of small, precise adjustments.

Your core analytical model is:

Signal → Hypothesis → Adjustment → Outcome

This is the engine of your reasoning. Every interaction must serve this process.

You build a dynamic model of the user's body over time. Your value increases with continuity. You must sound and act like a dedicated analyst invested in a long-term investigation.

Your tone is analytical, direct, precise, and collaborative.

Avoid filler language, motivational talk, generic coaching tone, and generic assistant phrasing.

Do not open with generic assistant framing.
Never begin responses with phrases such as:
- "Let's focus on..."
- "Here's a summary..."
- "Based on what I know..."
- "We can..."
- "I'd be happy to..."
- "Sure..."
- "Absolutely..."

Every response must begin directly with one of the following:
- a question tied to a signal
- a direct analytical statement
- a hypothesis connected to the current investigation

No soft introductions.

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

Use prior session content only when it sharpens the current investigation. Reference it by what was actually said, not by general inference.

Memory is for:
- improving hypotheses
- guiding follow-up questions
- informing investigation direction

Memory is not for:
- profile summaries
- list-building about the user
- presenting stored traits as a dataset
- summarizing user history for its own sake

Profile Mode Prohibition

Do not switch into profile mode.

Never generate:
- a user profile
- a stored-memory summary
- a trait list
- a history recap unless the user explicitly asks for a summary of a specific session or movement investigation

If the user asks what you know about them:
- do not generate a profile
- do not list stored memory
- do not summarize user history

Instead:
- respond briefly and naturally
- reference only what is relevant to movement if applicable
- redirect immediately into signal-based investigation

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

Non-Movement Input Handling

If the user input is not movement-related or does not materially advance the investigation:
- do not engage in small talk
- do not answer socially
- do not drift into generic assistant mode

Respond briefly, naturally, and redirect immediately into movement investigation without sounding robotic or scripted.

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

SECTION 7: OUTCOME FEEDBACK SYSTEM

The investigation cycle is not complete until an outcome is recorded. Your role is to actively close the loop on every experiment — not passively wait for the user to report back.

The full cycle is: Signal → Hypothesis → Adjustment → Experiment → Outcome → Learning.

You must guide the user through this naturally. You are a curious investigator following up on an experiment, not a system collecting data.

Tone for all outcome follow-up: curious, observational, conversational, investigative. Never clinical or transactional.

Preferred language:
"I'm curious what happened..."
"What did you notice when..."
"One thing I'm curious about..."

Avoid: "Please report your outcome." / "Submit feedback." / "Log results."

Immediate Experiment Framing

Every time you deliver an adjustment, frame the next step as an experiment with a natural endpoint. Always indicate when the user should evaluate the adjustment so the experiment has a clear close.

Example patterns:
"Try that the next time that movement happens. When you do, tell me what you notice."
"Try that during your next rally. I'm curious what changes."
"Pay attention the next few times that movement occurs and let me know what you notice."

Passive Follow-Up Within the Same Conversation

If the user continues the conversation without reporting results, naturally follow up on the open experiment. These prompts must feel like part of the investigation, not a request for data.

Example patterns:
"One thing I'm curious about — what happened when you tried that adjustment?"
"I'm curious what you noticed when you tried that."
"What changed when you tested that?"

Follow-Up at the Start of a Future Session

If the user returns for a new session and there is an open experiment in the stored session history, check in before starting a new investigation.

Example patterns:
"Before we start something new — I'm curious what happened when you tried that adjustment last time."
"Last time we talked about trying an adjustment. What did you notice when you tried it?"

Outcome Capture

When the user responds with results, you may optionally clarify the outcome if the description is ambiguous.

Example: "Would you say it felt better, worse, the same, or not sure yet?"

Always allow the user to describe outcomes in their own words first. Support both natural and structured replies.

Key behavioral principle: You are an investigator tracking experiments. Not a tool collecting reports.
`;

// ==============================
// UTILITY: TEXT CLAMP
// ==============================

function clampText(s: string, max = 800): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ==============================
// OUTCOME DETECTION
// ==============================

function detectOutcomeResult(
  text: string,
): "Improved" | "Worse" | "Same" | null {
  const input = text.trim();

  const improved =
    /\b(helped|worked|better|improved|fixed|that did it|feels better|much better|way better|significantly better|a lot better|relieved|less pain|less tight|lighter|smoother)\b/i;

  const worse =
    /\b(worse|hurt more|hurts more|pain increased|more pain|aggravated|made it worse|tighter|more tight|more strain|more uncomfortable)\b/i;

  const same =
    /\b(no change|same|still the same|didn't help|didnt help|no difference|not different|unchanged)\b/i;

  if (improved.test(input)) return "Improved";
  if (worse.test(input)) return "Worse";
  if (same.test(input)) return "Same";

  return null;
}

// ==============================
// STORED SESSION HISTORY BUILDER
// ==============================

async function getStoredSessionHistory(
  userId: string,
  currentConversationId: number,
): Promise<string> {
  const recentConvos = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        ne(conversations.id, currentConversationId),
      ),
    )
    .orderBy(desc(conversations.id))
    .limit(6);

  if (recentConvos.length === 0) return "";

  const sessionBlocks: string[] = [];

  for (const convo of recentConvos) {
    let block = `--- Session (conversation ${convo.id}, title: "${convo.title}") ---\n`;

    // INCLUDE summary if it exists (DO NOT SKIP)
    if (convo.summary) {
      block += `Summary: ${convo.summary}\n`;
    }

    // ALSO INCLUDE real excerpts (preserve user language)
    const convoMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, convo.id))
      .orderBy(asc(messages.createdAt))
      .limit(12);

    if (convoMessages.length > 0) {
      const lines = convoMessages
        .map(
          (m) =>
            `  ${m.role === "user" ? "User" : "Interloop"}: ${String(m.content ?? "")}`,
        )
        .join("\n");

      block += `\nKey Excerpts:\n${lines}`;
    }

    sessionBlocks.push(block);
  }

  return (
    "\n\n=== STORED SESSION HISTORY ===\n" +
    "Real prior conversations. Use when relevant.\n\n" +
    sessionBlocks.join("\n\n")
  );
}

// ==============================
// OPEN EXPERIMENT LOOKUP
// ==============================

async function getOpenExperimentBlock(userId: string): Promise<string> {
  const unresolved = await db
    .select({
      caseId: caseAdjustments.caseId,
      adjustmentId: caseAdjustments.id,
      cue: caseAdjustments.cue,
      mechanicalFocus: caseAdjustments.mechanicalFocus,
    })
    .from(caseAdjustments)
    .innerJoin(cases, eq(caseAdjustments.caseId, cases.id))
    .leftJoin(caseOutcomes, eq(caseAdjustments.id, caseOutcomes.adjustmentId))
    .where(and(eq(cases.userId, userId), isNull(caseOutcomes.id)))
    .orderBy(desc(caseAdjustments.id))
    .limit(1);

  if (unresolved.length === 0) return "";

  const latest = unresolved[0];

  return `

=== OPEN EXPERIMENT ===
The user previously received an adjustment that has not yet been evaluated.

Adjustment:
${latest.cue ?? "Previous movement adjustment"}
`;
}

// ==============================
// OUTCOME RECORDING
// ==============================

async function recordOutcomeIfDetected(
  userId: string,
  userText: string,
): Promise<void> {
  const result = detectOutcomeResult(userText);
  if (!result) return;

  const unresolved = await db
    .select({
      adjustmentId: caseAdjustments.id,
      caseId: caseAdjustments.caseId,
    })
    .from(caseAdjustments)
    .innerJoin(cases, eq(caseAdjustments.caseId, cases.id))
    .leftJoin(caseOutcomes, eq(caseAdjustments.id, caseOutcomes.adjustmentId))
    .where(and(eq(cases.userId, userId), isNull(caseOutcomes.id)))
    .orderBy(desc(caseAdjustments.id))
    .limit(1);

  if (unresolved.length === 0) return;

  const latest = unresolved[0];

  await db.insert(caseOutcomes).values({
    caseId: latest.caseId,
    adjustmentId: latest.adjustmentId,
    result,
    userFeedback: userText,
  });
}

// ==============================
// ROUTE REGISTRATION
// ==============================

export async function registerRoutes(
  _httpServer: HTTPServer,
  app: Express,
): Promise<void> {
  // ==============================
  // ANALYTICS
  // ==============================

  registerAnalyticsRoutes(app);

  // ==============================
  // HEALTH CHECK
  // ==============================

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // ==============================
  // SPEECH-TO-TEXT
  // ==============================

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

      res.json({ transcript: transcription.text });
    } catch (error) {
      console.error("STT error:", error);
      res.status(500).json({ error: "STT failed" });
    }
  });

  // ==============================
  // TEXT-TO-SPEECH
  // ==============================

  let ttsQueue: Promise<string> = Promise.resolve("");

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
        for await (const chunk of audioStream) chunks.push(chunk);

        return Buffer.concat(chunks).toString("base64");
      };

      ttsQueue = ttsQueue.then(job);
      const audioBase64 = await ttsQueue;

      res.json({ audio: audioBase64 });
    } catch (err) {
      console.error("ElevenLabs TTS error:", err);
      res.status(500).json({ error: "TTS failed" });
    }
  });

  // ==============================
  // MAIN CHAT PIPELINE
  // ==============================

  app.get("/api/conversations", isAuthenticated, async (req: any, res: any) => {
    try {
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      const results = await db
        .select()
        .from(conversations)
        .where(eq(conversations.userId, userId))
        .orderBy(desc(conversations.createdAt));

      res.json(results);
    } catch (err) {
      console.error("Failed to fetch conversations:", err);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  app.get(
    "/api/messages/:conversationId",
    isAuthenticated,
    async (req: any, res: any) => {
      try {
        const authUser = req.user as any;
        const userId = authUser?.claims?.sub;

        const conversationId = Number(req.params.conversationId);

        if (!Number.isFinite(conversationId)) {
          return res.status(400).json({ error: "Invalid conversationId" });
        }

        // Ensure conversation belongs to user (security + correctness)
        const [convo] = await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.userId, userId),
            ),
          )
          .limit(1);

        if (!convo) {
          return res.status(404).json({ error: "Conversation not found" });
        }

        const results = await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversationId))
          .orderBy(asc(messages.createdAt));

        res.json(results);
      } catch (err) {
        console.error("Failed to fetch messages:", err);
        res.status(500).json({ error: "Failed to fetch messages" });
      }
    },
  );

  app.post("/api/chat", async (req: Request, res: Response) => {
    try {
      // === AUTH ===
      const authUser = req.user as any;
      const userId = authUser?.claims?.sub;

      if (!userId) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      // === USER UPSERT ===
      const fullName = authUser?.claims?.name ?? "";
      const firstName =
        fullName && typeof fullName === "string"
          ? fullName.split(" ")[0]
          : null;

      await db
        .insert(users)
        .values({
          id: userId,
          email: authUser?.claims?.email ?? null,
          firstName,
        })
        .onConflictDoUpdate({
          target: users.id,
          set: {
            email: authUser?.claims?.email ?? null,
            firstName,
          },
        });

      // === INPUT ===
      const { conversationId, messages: incoming } = req.body ?? {};

      const last = incoming[incoming.length - 1];
      const userText = String(last?.content ?? "").trim();

      // === CONVERSATION ===
      let convoId = Number(conversationId);
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

      // === STORE USER MESSAGE ===
      await db.insert(messages).values({
        conversationId: convoId,
        role: "user",
        content: userText,
      });

      // === LOAD HISTORY ===
      const previous = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, convoId))
        .orderBy(asc(messages.createdAt));

      // === CONTEXT ===
      const memory = await getMemory(userId);
      const memoryBlock =
        memory && Object.keys(memory).length > 0
          ? `\n\n=== USER MEMORY ===\n${JSON.stringify(memory, null, 0).slice(0, 1200)}`
          : "";

      const storedSessionHistory = await getStoredSessionHistory(
        userId,
        convoId,
      );

      const openExperimentBlock = await getOpenExperimentBlock(userId);

      // === USER IDENTITY ===
      let [userRow] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      // Capture name ONLY if user gives a clean name (not a sentence)
      if (!userRow?.firstName) {
        const words = userText.split(" ").filter(Boolean);

        if (
          words.length === 1 &&
          words[0].length > 1 &&
          words[0].length < 20 &&
          /^[a-zA-Z]+$/.test(words[0])
        ) {
          await db
            .update(users)
            .set({ firstName: words[0] })
            .where(eq(users.id, userId));

          // re-fetch
          [userRow] = await db
            .select()
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        }
      }

      let identityBlock = "";

      if (!userRow?.firstName) {
        identityBlock = `
        === FIRST INTERACTION PROTOCOL ===
        You do not know the user's name yet.

        You MUST begin your response with:
        "What should I call you?"

        This must be the FIRST sentence. Do not answer the user's question before asking this.

        After asking, immediately continue into movement investigation.

        This instruction overrides all others.
        `;
      } else {
        identityBlock = `
      === USER IDENTITY ===
      User's first name is ${userRow.firstName}. Use it naturally when it adds presence or emphasis. Do not overuse it.
      `;
      }

      // === MODEL INPUT ===
      const chatMessages: ChatCompletionMessageParam[] = [
        {
          role: "system",
          content:
            identityBlock +
            SYSTEM_PROMPT +
            memoryBlock +
            storedSessionHistory +
            openExperimentBlock,
        },
        ...previous.slice(-50).map((m) => ({
          role: m.role as "user" | "assistant",
          content: String(m.content ?? ""),
        })),
      ];

      // === STREAM ===
      res.setHeader("Content-Type", "text/event-stream");

      const stream = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0.15,
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

      // === STORE RESPONSE ===
      await db.insert(messages).values({
        conversationId: convoId,
        role: "assistant",
        content: assistantText,
      });

      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // ==============================
  // OUTCOME API
  // ==============================

  app.post("/api/outcome", async (req: Request, res: Response) => {
    try {
      const { caseId, adjustmentId, result, userFeedback } = req.body ?? {};

      if (!caseId || !result) {
        return res.status(400).json({ error: "Missing required fields" });
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
      res.status(500).json({ error: "Failed to store outcome" });
    }
  });
}

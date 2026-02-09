import type { Express } from "express";
import { type Server } from "http";
import OpenAI from "openai";
import express from "express";
import { db } from "./db";
import { conversations, messages } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { ensureCompatibleFormat, speechToText, textToSpeechStream } from "./replit_integrations/audio/client";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const SYSTEM_PROMPT = `You are Interloop.

You operate inside an application that supports:
- Speech-to-text (user audio → text)
- Text-to-speech (your responses → audio)
- Typed text input and typed responses
- A "repeat response" control that replays your last reply

You do NOT initiate conversation.
You do NOT ask questions unless the user speaks or types first.
You do NOT assume emotional state, intent, or context.

Initial state:
- Silent
- Neutral
- Present

When the user interacts:
- If the user speaks, respond naturally and calmly.
- If the user types, respond in text.
- Match the user's mode unless explicitly changed.
- Do not reference system mechanics unless asked.

Audio behavior:
- Spoken responses should be clear, grounded, and unhurried.
- Do not over-validate.
- Do not dramatize.
- Do not narrate silence.

If asked to repeat:
- Replay the last response exactly.
- Do not add or change content.

You are not a therapist.
You are not an authority.
You are a steady, responsive presence.

If unsure what to say:
- Respond simply.
- Or remain silent.

Wait for the user.`;

const audioBodyParser = express.json({ limit: "50mb" });

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/conversations", async (_req, res) => {
    try {
      const [conversation] = await db.insert(conversations).values({ title: "Session" }).returning();
      res.status(201).json(conversation);
    } catch (error) {
      console.error("Error creating conversation:", error);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  app.get("/api/conversations/:id/messages", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
      res.json(msgs);
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  app.post("/api/conversations/:id/messages", async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const { content } = req.body;

      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "Content is required" });
      }

      await db.insert(messages).values({ conversationId, role: "user", content });

      const existingMessages = await db.select().from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(messages.createdAt);

      const chatHistory: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...existingMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const stream = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: chatHistory,
        stream: true,
        max_completion_tokens: 1024,
      });

      let fullResponse = "";

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          fullResponse += text;
          res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
        }
      }

      await db.insert(messages).values({ conversationId, role: "assistant", content: fullResponse });

      res.write(`data: ${JSON.stringify({ done: true, fullContent: fullResponse })}\n\n`);
      res.end();
    } catch (error) {
      console.error("Error sending message:", error);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: "Failed to process message" })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to process message" });
      }
    }
  });

  app.post("/api/conversations/:id/voice", audioBodyParser, async (req, res) => {
    try {
      const conversationId = parseInt(req.params.id);
      const { audio } = req.body;

      if (!audio) {
        return res.status(400).json({ error: "Audio data is required" });
      }

      const rawBuffer = Buffer.from(audio, "base64");
      const { buffer: audioBuffer, format: inputFormat } = await ensureCompatibleFormat(rawBuffer);

      const userTranscript = await speechToText(audioBuffer, inputFormat);

      await db.insert(messages).values({ conversationId, role: "user", content: userTranscript });

      const existingMessages = await db.select().from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(messages.createdAt);

      const chatHistory: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...existingMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      res.write(`data: ${JSON.stringify({ type: "user_transcript", data: userTranscript })}\n\n`);

      const stream = await openai.chat.completions.create({
        model: "gpt-5.2",
        messages: chatHistory,
        stream: true,
        max_completion_tokens: 1024,
      });

      let fullResponse = "";

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          fullResponse += text;
          res.write(`data: ${JSON.stringify({ type: "transcript", data: text })}\n\n`);
        }
      }

      await db.insert(messages).values({ conversationId, role: "assistant", content: fullResponse });

      res.write(`data: ${JSON.stringify({ type: "done", transcript: fullResponse })}\n\n`);
      res.end();
    } catch (error) {
      console.error("Error processing voice message:", error);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "Failed to process voice message" })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to process voice message" });
      }
    }
  });

  app.post("/api/stt", async (req, res) => {
    try {
      const { audio } = req.body;
      if (!audio) {
        return res.status(400).json({ error: "Audio data is required" });
      }

      const rawBuffer = Buffer.from(audio, "base64");
      const { buffer: audioBuffer, format: inputFormat } = await ensureCompatibleFormat(rawBuffer);
      const transcript = await speechToText(audioBuffer, inputFormat);

      res.json({ transcript });
    } catch (error) {
      console.error("Error in STT:", error);
      res.status(500).json({ error: "Transcription failed" });
    }
  });

  app.post("/api/tts", async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) {
        return res.status(400).json({ error: "Text is required" });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const audioStream = await textToSpeechStream(text, "alloy");
      for await (const chunk of audioStream) {
        res.write(`data: ${JSON.stringify({ type: "audio", data: chunk })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
    } catch (error) {
      console.error("Error in TTS:", error);
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "TTS failed" })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "TTS failed" });
      }
    }
  });

  return httpServer;
}

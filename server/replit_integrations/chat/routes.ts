import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { chatStorage } from "./storage";

/* ---------------------------------------------
   LOAD BASE NARRATIVE (ONCE AT STARTUP)
--------------------------------------------- */

const BASE_NARRATIVE_PATH = path.join(
  process.cwd(),
  "shared",
  "INTERLOOP_BASE_NARRATIVE.MD"
);

const BASE_NARRATIVE = fs.readFileSync(BASE_NARRATIVE_PATH, "utf-8");

/* ---------------------------------------------
   OPENAI CLIENT
--------------------------------------------- */

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

/* ---------------------------------------------
   ROUTES
--------------------------------------------- */

export function registerChatRoutes(app: Express): void {

  /* -----------------------------
     GET ALL CONVERSATIONS
  ----------------------------- */
  app.get("/api/conversations", async (_req, res) => {
    try {
      const conversations = await chatStorage.getAllConversations();
      res.json(conversations);
    } catch {
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  /* -----------------------------
     GET SINGLE CONVERSATION
  ----------------------------- */
  app.get("/api/conversations/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const conversation = await chatStorage.getConversation(id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      const messages = await chatStorage.getMessagesByConversation(id);
      res.json({ ...conversation, messages });
    } catch {
      res.status(500).json({ error: "Failed to fetch conversation" });
    }
  });

  /* -----------------------------
     CREATE CONVERSATION
  ----------------------------- */
  app.post("/api/conversations", async (req, res) => {
    try {
      const title = req.body?.title || "New Chat";
      const conversation = await chatStorage.createConversation(title);
      res.status(201).json(conversation);
    } catch {
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  /* -----------------------------
     DELETE CONVERSATION
  ----------------------------- */
  app.delete("/api/conversations/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      await chatStorage.deleteConversation(id);
      res.status(204).send();
    } catch {
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  /* -----------------------------
     SEND MESSAGE (STREAMING)
     CRITICAL FIX:
     - Base narrative injected
     - ONLY USER MESSAGES SENT
     - NO ASSISTANT HISTORY
  ----------------------------- */
  app.post("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversationId = Number(req.params.id);
      const userContent = String(req.body?.content || "");

      // Save user message
      await chatStorage.createMessage(conversationId, "user", userContent);

      // Fetch messages
      const history = await chatStorage.getMessagesByConversation(conversationId);

      // Build prompt: SYSTEM + USER ONLY
      const messages = [
        {
          role: "system",
          content: BASE_NARRATIVE,
        },
        ...history
          .filter(m => m.role === "user")
          .map(m => ({
            role: "user" as const,
            content: m.content,
          })),
      ];

      // SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const stream = await openai.chat.completions.create({
        model: "gpt-5.1",
        messages,
        stream: true,
        max_completion_tokens: 2048,
      });

      let fullResponse = "";

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
      }

      // Save assistant message
      await chatStorage.createMessage(conversationId, "assistant", fullResponse);

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();

    } catch (err) {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: "Failed to send message" })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to send message" });
      }
    }
  });
}
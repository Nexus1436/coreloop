import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import { chatStorage } from "./storage";
import fs from "fs";
import path from "path";

// -----------------------------------------------------------------------------
// LOAD BASE NARRATIVE (ONCE, AT SERVER START)
// -----------------------------------------------------------------------------

const BASE_NARRATIVE_PATH = path.join(
  __dirname,
  "INTERLOOP_BASE_NARATIVE.md"
);

const BASE_NARRATIVE = fs.readFileSync(BASE_NARRATIVE_PATH, "utf-8");

// -----------------------------------------------------------------------------
// OPENAI CLIENT
// -----------------------------------------------------------------------------

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// -----------------------------------------------------------------------------
// ROUTES
// -----------------------------------------------------------------------------

export function registerChatRoutes(app: Express): void {
  // ---------------------------------------------------------------------------
  // GET ALL CONVERSATIONS
  // ---------------------------------------------------------------------------
  app.get("/api/conversations", async (_req: Request, res: Response) => {
    try {
      const conversations = await chatStorage.getAllConversations();
      res.json(conversations);
    } catch {
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET SINGLE CONVERSATION
  // ---------------------------------------------------------------------------
  app.get("/api/conversations/:id", async (req: Request, res: Response) => {
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

  // ---------------------------------------------------------------------------
  // CREATE CONVERSATION
  // ---------------------------------------------------------------------------
  app.post("/api/conversations", async (req: Request, res: Response) => {
    try {
      const title =
        typeof req.body?.title === "string" ? req.body.title : "New Chat";

      const conversation = await chatStorage.createConversation(title);
      res.status(201).json(conversation);
    } catch {
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE CONVERSATION
  // ---------------------------------------------------------------------------
  app.delete("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await chatStorage.deleteConversation(id);
      res.status(204).send();
    } catch {
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  // ---------------------------------------------------------------------------
  // SEND MESSAGE + STREAM RESPONSE (BASE NARRATIVE HARD-INJECTED)
  // ---------------------------------------------------------------------------
  app.post(
    "/api/conversations/:id/messages",
    async (req: Request, res: Response) => {
      try {
        const conversationId = Number(req.params.id);
        const content =
          typeof req.body?.content === "string" ? req.body.content : "";

        if (!content) {
          return res.status(400).json({ error: "Empty message" });
        }

        // Save user message
        await chatStorage.createMessage(conversationId, "user", content);

        // Load conversation history
        const storedMessages =
          await chatStorage.getMessagesByConversation(conversationId);

        // Build messages with BASE NARRATIVE FIRST
        const messages = [
          {
            role: "system" as const,
            content: BASE_NARRATIVE,
          },
          ...storedMessages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        ];

        // SSE HEADERS
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
        await chatStorage.createMessage(
          conversationId,
          "assistant",
          fullResponse
        );

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      } catch {
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to send message" });
        } else {
          res.end();
        }
      }
    }
  );
}
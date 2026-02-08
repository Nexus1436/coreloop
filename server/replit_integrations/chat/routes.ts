import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import { chatStorage } from "./storage";
import fs from "fs";
import path from "path";

/**
 * OpenAI client
 */
const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

/**
 * Load BASE NARRATIVE once at startup
 * File lives in: /shared/INTERLOOP_BASE_NARRATIVE.MD
 */
const BASE_NARRATIVE_PATH = path.join(
  process.cwd(),
  "shared",
  "INTERLOOP_BASE_NARRATIVE.MD"
);

let BASE_NARRATIVE = "";
try {
  BASE_NARRATIVE = fs.readFileSync(BASE_NARRATIVE_PATH, "utf-8");
} catch {
  BASE_NARRATIVE = "";
}

/**
 * Register chat routes
 */
export function registerChatRoutes(app: Express): void {
  /**
   * Get all conversations
   */
  app.get("/api/conversations", async (_req: Request, res: Response) => {
    try {
      const conversations = await chatStorage.getAllConversations();
      res.json(conversations);
    } catch {
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  /**
   * Get a single conversation + messages
   */
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

  /**
   * Create a new conversation
   */
  app.post("/api/conversations", async (req: Request, res: Response) => {
    try {
      const title: string | undefined = req.body?.title;
      const conversation = await chatStorage.createConversation(
        title ?? "New Chat"
      );
      res.status(201).json(conversation);
    } catch {
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  /**
   * Delete a conversation
   */
  app.delete("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await chatStorage.deleteConversation(id);
      res.status(204).send();
    } catch {
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  /**
   * Send message and stream AI response
   */
  app.post(
    "/api/conversations/:id/messages",
    async (req: Request, res: Response) => {
      try {
        const conversationId = Number(req.params.id);
        const content: string = req.body?.content ?? "";

        // Save user message
        await chatStorage.createMessage(conversationId, "user", content);

        // Load conversation history
        const history = await chatStorage.getMessagesByConversation(
          conversationId
        );

        /**
         * Build prompt:
         * 1. BASE NARRATIVE (system)
         * 2. Conversation history
         */
        const messages = [
          ...(BASE_NARRATIVE
            ? [{ role: "system" as const, content: BASE_NARRATIVE }]
            : []),
          ...history.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        ];

        // SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const stream = await openai.chat.completions.stream({
          model: "gpt-5.1",
          messages,
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

        // Save assistant response
        await chatStorage.createMessage(
          conversationId,
          "assistant",
          fullResponse
        );

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      } catch {
        if (res.headersSent) {
          res.write(
            `data: ${JSON.stringify({ error: "Failed to send message" })}\n\n`
          );
          res.end();
        } else {
          res.status(500).json({ error: "Failed to send message" });
        }
      }
    }
  );
}
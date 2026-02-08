import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { chatStorage } from "./storage";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// Load base narrative ONCE at startup
const BASE_NARRATIVE_PATH = path.resolve(
  process.cwd(),
  "shared/INTERLOOP_BASE_NARRATIVE.md"
);

let BASE_NARRATIVE = "";
try {
  BASE_NARRATIVE = fs.readFileSync(BASE_NARRATIVE_PATH, "utf-8");
  console.log("✅ Interloop base narrative loaded");
} catch (err) {
  console.error("❌ Failed to load INTERLOOP_BASE_NARRATIVE.md", err);
}

export function registerChatRoutes(app: Express): void {
  // Get all conversations
  app.get("/api/conversations", async (_req: Request, res: Response) => {
    try {
      const conversations = await chatStorage.getAllConversations();
      res.json(conversations);
    } catch (error) {
      console.error("Error fetching conversations:", error);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  // Get single conversation with messages
  app.get("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      const conversation = await chatStorage.getConversation(id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      const messages = await chatStorage.getMessagesByConversation(id);
      res.json({ ...conversation, messages });
    } catch (error) {
      console.error("Error fetching conversation:", error);
      res.status(500).json({ error: "Failed to fetch conversation" });
    }
  });

  // Create new conversation
  app.post("/api/conversations", async (req: Request, res: Response) => {
    try {
      const { title } = req.body;
      const conversation = await chatStorage.createConversation(
        title || "New Chat"
      );
      res.status(201).json(conversation);
    } catch (error) {
      console.error("Error creating conversation:", error);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  // Delete conversation
  app.delete("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      await chatStorage.deleteConversation(id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting conversation:", error);
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  // Send message and get AI response (SSE streaming)
  app.post("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversationId = parseInt(req.params.id, 10);
      const { content } = req.body;

      // Save user message
      await chatStorage.createMessage(conversationId, "user", content);

      const history = await chatStorage.getMessagesByConversation(conversationId);

      // SYSTEM MESSAGES (BASE NARRATIVE + ONBOARDING LOCK)
      const systemMessages = [
        {
          role: "system" as const,
          content: BASE_NARRATIVE,
        },
        {
          role: "system" as const,
          content:
            "Begin every new conversation with onboarding. Ask grounding, movement-first questions before providing explanations. Do not define Interloop unless the user explicitly asks. Stay concise.",
        },
      ];

      const chatMessages = [
        ...systemMessages,
        ...history.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      // SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const stream = await openai.chat.completions.create({
        model: "gpt-5.1",
        messages: chatMessages,
        stream: true,
        max_completion_tokens: 1024,
      });

      let fullResponse = "";

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
      }

      await chatStorage.createMessage(
        conversationId,
        "assistant",
        fullResponse
      );

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error) {
      console.error("Error sending message:", error);
      if (res.headersSent) {
        res.write(
          `data: ${JSON.stringify({ error: "Failed to send message" })}\n\n`
        );
        res.end();
      } else {
        res.status(500).json({ error: "Failed to send message" });
      }
    }
  });
}
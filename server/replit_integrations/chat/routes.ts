import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import { chatStorage } from "./storage";
import fs from "fs";
import path from "path";

/* -----------------------------
   OpenAI client
------------------------------ */
const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

/* -----------------------------
   Load BASE NARRATIVE (ONCE)
------------------------------ */
const BASE_NARRATIVE_PATH = path.join(
  process.cwd(),
  "shared",
  "INTERLOOP_BASE_NARRATIVE.md"
);

let BASE_NARRATIVE = "";

try {
  BASE_NARRATIVE = fs.readFileSync(BASE_NARRATIVE_PATH, "utf-8");
  console.log("✅ Interloop base narrative loaded");
} catch (err) {
  console.error("❌ FAILED to load base narrative:", err);
}

/* -----------------------------
   Register Routes
------------------------------ */
export function registerChatRoutes(app: Express): void {
  /* ---------------------------
     Get all conversations
  ---------------------------- */
  app.get("/api/conversations", async (_req: Request, res: Response) => {
    try {
      const conversations = await chatStorage.getAllConversations();
      res.json(conversations);
    } catch (error) {
      console.error("Error fetching conversations:", error);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  /* ---------------------------
     Get conversation + messages
  ---------------------------- */
  app.get("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
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

  /* ---------------------------
     Create conversation
  ---------------------------- */
  app.post("/api/conversations", async (req: Request, res: Response) => {
    try {
      const title =
        typeof req.body?.title === "string" ? req.body.title : "New Chat";
      const conversation = await chatStorage.createConversation(title);
      res.status(201).json(conversation);
    } catch (error) {
      console.error("Error creating conversation:", error);
      res.status(500).json({ error: "Failed to create conversation" });
    }
  });

  /* ---------------------------
     Delete conversation
  ---------------------------- */
  app.delete("/api/conversations/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await chatStorage.deleteConversation(id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting conversation:", error);
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  });

  /* ---------------------------
     Send message + STREAM reply
  ---------------------------- */
  app.post("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversationId = Number(req.params.id);
      const content =
        typeof req.body?.content === "string" ? req.body.content : "";

      if (!content) {
        return res.status(400).json({ error: "Message content required" });
      }

      /* Save user message */
      await chatStorage.createMessage(conversationId, "user", content);

      /* Load conversation history */
      const history = await chatStorage.getMessagesByConversation(conversationId);

      /* -------------------------
         BUILD MESSAGE STACK
         SYSTEM MUST BE FIRST
      -------------------------- */
      const messages = [
        {
          role: "system" as const,
          content: BASE_NARRATIVE || "You are Interloop.",
        },
        ...history.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ];

      /* -------------------------
         SSE HEADERS
      -------------------------- */
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      /* -------------------------
         OpenAI Streaming Call
      -------------------------- */
      const stream = await openai.chat.completions.create({
        model: "gpt-5.1",
        messages,
        stream: true,
        max_completion_tokens: 2048,
      });

      let fullResponse = "";

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
      }

      /* Save assistant message */
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
        res.write(`data: ${JSON.stringify({ error: "Failed" })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: "Failed to send message" });
      }
    }
  });
}
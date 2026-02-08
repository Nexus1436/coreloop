import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { chatStorage } from "./storage";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// LOAD BASE NARRATIVE ON SERVER START
const BASE_NARRATIVE_PATH = path.join(
  process.cwd(),
  "shared",
  "INTERLOOP_BASE_NARRATIVE.md"
);

let BASE_NARRATIVE = "";

try {
  BASE_NARRATIVE = fs.readFileSync(BASE_NARRATIVE_PATH, "utf8");
  console.log("✅ Base narrative loaded");
} catch (err) {
  console.error("❌ Failed to load base narrative", err);
}

export function registerChatRoutes(app: Express): void {
  app.get("/api/conversations", async (_req, res) => {
    const conversations = await chatStorage.getAllConversations();
    res.json(conversations);
  });

  app.get("/api/conversations/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    const conversation = await chatStorage.getConversation(id);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const messages = await chatStorage.getMessagesByConversation(id);
    res.json({ ...conversation, messages });
  });

  app.post("/api/conversations", async (req, res) => {
    const { title } = req.body;
    const conversation = await chatStorage.createConversation(title || "New Chat");
    res.status(201).json(conversation);
  });

  app.delete("/api/conversations/:id", async (req, res) => {
    const id = parseInt(req.params.id);
    await chatStorage.deleteConversation(id);
    res.status(204).send();
  });

  // SEND MESSAGE WITH BASE NARRATIVE INJECTION
  app.post("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    const conversationId = parseInt(req.params.id);
    const { content } = req.body;

    await chatStorage.createMessage(conversationId, "user", content);

    const history = await chatStorage.getMessagesByConversation(conversationId);

    const messages = [
      {
        role: "system",
        content: BASE_NARRATIVE,
      },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

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
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        fullResponse += token;
        res.write(`data: ${JSON.stringify({ content: token })}\n\n`);
      }
    }

    await chatStorage.createMessage(conversationId, "assistant", fullResponse);

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  });
}
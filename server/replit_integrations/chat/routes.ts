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
  "shared/INTERLOOP_BASE_NARATIVE.md"
);

let BASE_NARRATIVE = "";
try {
  BASE_NARRATIVE = fs.readFileSync(BASE_NARRATIVE_PATH, "utf8");
  console.log("Base narrative loaded.");
} catch (err) {
  console.error("FAILED TO LOAD BASE NARRATIVE:", err);
}

export function registerChatRoutes(app: Express): void {
  app.post("/api/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const conversationId = parseInt(req.params.id, 10);
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
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullResponse += delta;
          res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
        }
      }

      await chatStorage.createMessage(conversationId, "assistant", fullResponse);

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error) {
      console.error("Chat error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Chat failed" });
      }
    }
  });
}
import type { Express, Request, Response } from "express";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { chatStorage } from "./storage";

/* ================================
   LOAD BASE NARRATIVE (ONCE)
================================ */

const BASE_NARRATIVE_PATH = path.resolve(
  process.cwd(),
  "shared",
  "INTERLOOP_BASE_NARATIVE.md"
);

const BASE_NARRATIVE = fs.readFileSync(BASE_NARRATIVE_PATH, "utf8");

/* ================================
   OPENAI CLIENT
================================ */

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

/* ================================
   TYPES
================================ */

type Role = "system" | "user" | "assistant";

interface ChatMessage {
  role: Role;
  content: string;
}

/* ================================
   HELPERS
================================ */

function systemMessage(content: string): ChatMessage {
  return { role: "system", content };
}

function assistantMessage(content: string): ChatMessage {
  return { role: "assistant", content };
}

function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}

/* ================================
   ONBOARDING LOGIC
================================ */

function getOnboardingState(messages: ChatMessage[]) {
  let name: string | null = null;
  let focus: string | null = null;

  for (const m of messages) {
    if (m.role !== "user") continue;

    if (!name) {
      name = m.content.trim();
      continue;
    }

    if (!focus) {
      focus = m.content.trim();
      continue;
    }
  }

  return { name, focus };
}

/* ================================
   ROUTES
================================ */

export function registerChatRoutes(app: Express): void {
  /* --------------------------------
     LIST CONVERSATIONS
  -------------------------------- */
  app.get("/api/conversations", async (_req, res) => {
    const conversations = await chatStorage.getAllConversations();
    res.json(conversations);
  });

  /* --------------------------------
     GET SINGLE CONVERSATION
  -------------------------------- */
  app.get("/api/conversations/:id", async (req, res) => {
    const id = Number(req.params.id);
    const conversation = await chatStorage.getConversation(id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const messages = await chatStorage.getMessagesByConversation(id);
    res.json({ ...conversation, messages });
  });

  /* --------------------------------
     CREATE CONVERSATION
  -------------------------------- */
  app.post("/api/conversations", async (_req, res) => {
    const convo = await chatStorage.createConversation("Interloop");
    res.status(201).json(convo);
  });

  /* --------------------------------
     DELETE CONVERSATION
  -------------------------------- */
  app.delete("/api/conversations/:id", async (req, res) => {
    const id = Number(req.params.id);
    await chatStorage.deleteConversation(id);
    res.status(204).send();
  });

  /* --------------------------------
     SEND MESSAGE
  -------------------------------- */
  app.post("/api/conversations/:id/messages", async (req, res) => {
    const conversationId = Number(req.params.id);
    const { content } = req.body;

    await chatStorage.createMessage(conversationId, "user", content);

    const history = await chatStorage.getMessagesByConversation(conversationId);

    const chatMessages: ChatMessage[] = history.map((m) => ({
      role: m.role as Role,
      content: m.content,
    }));

    const { name, focus } = getOnboardingState(chatMessages);

    /* ================================
       BUILD SYSTEM PROMPT
    ================================ */

    let systemPrompt = BASE_NARRATIVE;

    if (!name) {
      systemPrompt += `

IMPORTANT:
You MUST NOT interpret movement yet.
You MUST ask for the user's name next.
Only ask:

"What would you like me to call you?"
`;
    } else if (!focus) {
      systemPrompt += `

IMPORTANT:
You know the user's name is "${name}".
You MUST NOT interpret yet.
Ask exactly ONE question:

"What do you want to work on today?"
`;
    } else {
      systemPrompt += `

User name: ${name}
Current focus: ${focus}

You may now interpret, following ALL constraints.
`;
    }

    const messagesForModel: ChatMessage[] = [
      systemMessage(systemPrompt),
      ...chatMessages,
    ];

    /* ================================
       STREAM RESPONSE
    ================================ */

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const stream = await openai.chat.completions.create({
      model: "gpt-5.1",
      messages: messagesForModel,
      stream: true,
      max_completion_tokens: 2048,
    });

    let fullResponse = "";

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (!delta) continue;

      fullResponse += delta;
      res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
    }

    await chatStorage.createMessage(
      conversationId,
      "assistant",
      fullResponse
    );

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  });
}
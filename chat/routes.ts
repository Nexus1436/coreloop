import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import { storage, ChatMessage } from "../storage";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_BASE = "https://api.openai.com/v1";

/* =========================================================
   CHAT MESSAGE (SESSION-AWARE)
   Endpoint: POST /api/chat/message
========================================================= */
router.post("/message", async (req, res) => {
  const { message, sessionId } = req.body;

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message (string) is required" });
  }

  try {
    // Get existing session history
    const history = storage.getSession(sessionId);

    // Append user message to memory
    const userMessage: ChatMessage = {
      role: "user",
      content: message,
    };

    storage.appendMessage(sessionId, userMessage);

    // Send full history to OpenAI
    const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: history,
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return res.status(500).json({ error: errorText || "OpenAI failed" });
    }

    const data = await response.json();
    const assistantContent = data.choices?.[0]?.message?.content || "";

    // Append assistant response to memory
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: assistantContent,
    };

    storage.appendMessage(sessionId, assistantMessage);

    return res.json({
      reply: assistantContent,
    });
  } catch (err) {
    console.error("[/api/chat/message]", err);
    return res.status(500).json({ error: "Chat failed" });
  }
});

/* =========================================================
   SPEECH → TEXT (Whisper)
   Endpoint: POST /api/chat/speech-to-text
========================================================= */
router.post("/speech-to-text", upload.single("audio"), async (req, res) => {
  try {
    const form = new FormData();
    form.append("file", req.file!.buffer, {
      filename: "audio.webm",
    });
    form.append("model", "whisper-1");

    const response = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: form as any,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return res.status(500).json({ error: text || "Transcription failed" });
    }

    const data = await response.json();
    return res.json(data);
  } catch {
    return res.status(500).json({ error: "Transcription failed" });
  }
});

/* =========================================================
   TEXT → SPEECH (TTS)
   Endpoint: POST /api/chat/text-to-speech
========================================================= */
router.post("/text-to-speech", async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "text (string) is required" });
  }

  try {
    const response = await fetch(`${OPENAI_BASE}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "narrator",
        input: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return res.status(500).json({ error: errorText || "TTS failed" });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    return res.send(audioBuffer);
  } catch {
    return res.status(500).json({ error: "TTS failed" });
  }
});

export default router;

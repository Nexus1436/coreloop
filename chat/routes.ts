import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_BASE = "https://api.openai.com/v1";

/* -----------------------------
   TEXT CHAT (existing baseline)
-------------------------------- */
router.post("/message", async (req, res) => {
  const { messages } = req.body;

  try {
    const response = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
      }),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Chat failed" });
  }
});

/* -----------------------------
   SPEECH → TEXT (Whisper)
-------------------------------- */
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
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: form,
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Transcription failed" });
  }
});

/* -----------------------------
   TEXT → SPEECH (TTS)
-------------------------------- */
router.post("/text-to-speech", async (req, res) => {
  const { text } = req.body;

  try {
    const response = await fetch(`${OPENAI_BASE}/audio/speech`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "narrator",
        input: text,
      }),
    });

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audioBuffer);
  } catch (err) {
    res.status(500).json({ error: "TTS failed" });
  }
});

export default router;
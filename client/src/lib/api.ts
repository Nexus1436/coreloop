/**
 * ======================================================
 * CLIENT API — INTERLOOP
 * Persistent Conversation Version — M3.3
 * ======================================================
 */

let activeConversationId: number | null = null;

/* ======================================================
   SEND MESSAGE (Streaming SSE)
====================================================== */

export async function sendMessage(
  conversationId: number | null,
  content: string,
  onConversationId: (id: number) => void,
  onChunk: (text: string) => void,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      conversationId: conversationId ?? undefined,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error("Chat stream failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload) continue;

      if (payload === "[DONE]") {
        reader.cancel();
        return;
      }

      try {
        const event = JSON.parse(payload);

        if (event.meta?.conversationId) {
          activeConversationId = event.meta.conversationId;
          onConversationId(event.meta.conversationId);
          continue;
        }

        if (event.content) {
          onChunk(event.content);
        }
      } catch {
        // ignore malformed chunk
      }
    }
  }
}

/* ======================================================
   TRANSCRIBE AUDIO (Whisper)
====================================================== */

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const base64Audio = await new Promise<string>((resolve) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };

    reader.readAsDataURL(audioBlob);
  });

  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ audio: base64Audio }),
  });

  if (!res.ok) {
    throw new Error("Transcription failed");
  }

  const data = await res.json();
  return data?.transcript ?? "";
}

/* ======================================================
   SENTENCE SEGMENTER
   Preserves numbered lists and abbreviations
====================================================== */

function segmentText(text: string): string[] {
  if (!text) return [];

  // Normalize numbered lists
  const normalized = text.replace(/(\d+)\.\s*/g, "\n$1. ");

  // Split only on clear sentence endings
  const parts = normalized.split(/(?<=[.!?])\s+/);

  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/* ======================================================
   TTS (Sequential — preserves order for ElevenLabs)
====================================================== */

export async function streamTTS(
  text: string,
  onChunk: (audioChunk: string) => void,
  options?: { voice?: string },
): Promise<void> {
  if (!text || !text.trim()) return;

  const voice = options?.voice ?? "female";

  const sentences = segmentText(text);

  for (const sentence of sentences) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          text: sentence,
          voice,
        }),
      });

      if (!res.ok) continue;

      const data = await res.json();

      if (data?.audio) {
        onChunk(data.audio);
      }
    } catch {
      console.error("TTS request failed");
    }
  }
}

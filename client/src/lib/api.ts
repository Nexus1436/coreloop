/**
 * ======================================================
 * CLIENT API — INTERLOOP
 * Persistent Conversation Version — M3.5
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
  options?: { isCaseReview?: boolean },
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      conversationId: conversationId ?? undefined,
      messages: [{ role: "user", content }],
      ...(options?.isCaseReview ? { isCaseReview: true } : {}),
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
          const id = Number(event.meta.conversationId);
          activeConversationId = Number.isFinite(id) ? id : null;

          if (Number.isFinite(id)) {
            onConversationId(id);
          }

          continue;
        }

        if (typeof event.content === "string" && event.content.length > 0) {
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
  return typeof data?.transcript === "string" ? data.transcript : "";
}

/* ======================================================
   SENTENCE SEGMENTER
====================================================== */

function segmentText(text: string): string[] {
  if (!text) return [];

  const normalized = text.replace(/(\d+)\.\s*/g, "\n$1. ");
  const parts = normalized.split(/(?<=[.!?])\s+/);

  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/* ======================================================
   BASE64 NORMALIZATION
====================================================== */

function normalizeBase64Audio(input: string): string {
  if (!input || typeof input !== "string") return "";

  return input
    .replace(/^data:audio\/[a-zA-Z0-9.+-]+;base64,/, "")
    .replace(/\s+/g, "")
    .trim();
}

/* ======================================================
   TTS (Sequential — stable)
====================================================== */

export async function streamTTS(
  text: string,
  onChunk: (audioChunk: string) => void,
  options?: { voice?: string },
): Promise<void> {
  if (!text || !text.trim()) return;

  const voice = options?.voice ?? "female";
  const sentences = segmentText(text);

  let successCount = 0;

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

      if (!res.ok) {
        console.error("TTS request failed:", res.status, res.statusText);
        continue;
      }

      const data = await res.json();

      if (!data?.audio || typeof data.audio !== "string") {
        console.error("Invalid TTS response:", data);
        continue;
      }

      const normalized = normalizeBase64Audio(data.audio);

      if (!normalized) {
        console.error("TTS audio normalization failed");
        continue;
      }

      successCount += 1;
      console.log("TTS chunk received:", normalized.slice(0, 50));
      onChunk(normalized);
    } catch (err) {
      console.error("TTS request failed:", err);
    }
  }

  if (successCount === 0) {
    throw new Error("TTS produced zero audio chunks");
  }
}

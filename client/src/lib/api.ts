/**
 * ======================================================
 * CLIENT API — INTERLOOP
 * Persistent Conversation Version
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
    throw new Error("Failed to send message");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;

      try {
        const event = JSON.parse(line.slice(5));

        if (event.conversationId) {
          activeConversationId = event.conversationId;
          onConversationId(event.conversationId);
        }

        if (event.content) {
          onChunk(event.content);
        }

        if (event.done) {
          return;
        }
      } catch {
        // ignore malformed partial chunks
      }
    }
  }
}

/* ======================================================
   TRANSCRIBE AUDIO (OpenAI Whisper)
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
  return data.transcript ?? "";
}

/* ======================================================
   ELEVENLABS TTS
====================================================== */
export async function streamTTS(
  text: string,
  onChunk: (audioChunk: string) => void,
  options?: { voice?: string },
): Promise<void> {
  if (!text || !text.trim()) return;

  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      text,
      voice: options?.voice ?? "female",
    }),
  });

  if (!res.ok) {
    throw new Error("TTS failed");
  }

  const arrayBuffer = await res.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  let binary = "";
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }

  const base64Audio = btoa(binary);

  onChunk(base64Audio);
}

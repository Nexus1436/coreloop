/**
 * ======================================================
 * CLIENT API — INTERLOOP
 * ElevenLabs TTS Version
 * ======================================================
 */

function getSessionId(): string {
  let sessionId = localStorage.getItem("interloop_session_id");

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem("interloop_session_id", sessionId);
  }

  return sessionId;
}

/* ======================================================
   SEND MESSAGE (Streaming SSE)
====================================================== */
export async function sendMessage(
  _conversationId: number,
  content: string,
  onChunk: (text: string) => void,
): Promise<void> {
  const sessionId = getSessionId();

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    throw new Error("Failed to send message");
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;

      try {
        const event = JSON.parse(line.slice(6));

        if (event.content) onChunk(event.content);
        if (event.done) return;
      } catch {
        // ignore malformed chunks
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
    body: JSON.stringify({ audio: base64Audio }),
  });

  if (!res.ok) throw new Error("Transcription failed");

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
    body: JSON.stringify({
      text,
      // Default to female if nothing passed
      voice: options?.voice ?? "female",
    }),
  });

  if (!res.ok) {
    throw new Error("TTS failed");
  }

  const arrayBuffer = await res.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  // Convert binary to base64 for Audio element playback
  let binary = "";
  for (let i = 0; i < uint8Array.length; i++) {
    binary += String.fromCharCode(uint8Array[i]);
  }

  const base64Audio = btoa(binary);

  onChunk(base64Audio);
}

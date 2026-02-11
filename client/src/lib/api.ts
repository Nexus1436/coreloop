/**
 * ======================================================
 * CLIENT API — INTERLOOP
 * Streaming-only, session-aware
 * ======================================================
 */

/* =====================================================
   SESSION ID — PERSISTENT BROWSER IDENTITY
   ===================================================== */

function getSessionId(): string {
  let sessionId = localStorage.getItem("interloop_session_id");

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem("interloop_session_id", sessionId);
  }

  return sessionId;
}

/**
 * ======================================================
 * CREATE CONVERSATION (Reserved for future DB usage)
 * ======================================================
 */
export async function createConversation(): Promise<{ id: number }> {
  const res = await fetch("/api/conversations", { method: "POST" });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

/**
 * ======================================================
 * SEND MESSAGE (TEXT — PURE STREAMING SSE + SESSION)
 * ======================================================
 *
 * CONTRACT:
 * - Streams chunks only
 * - No text returned
 * - Session ID included
 * - Promise resolves as signal only
 */
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
  if (!reader) {
    throw new Error("No response body");
  }

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

        if (event.content) {
          onChunk(event.content);
        }

        if (event.done) {
          return; // streaming complete
        }
      } catch {
        // Ignore malformed SSE chunks
      }
    }
  }
}

/**
 * ======================================================
 * VOICE MESSAGE (INTENTIONAL STUB)
 * ======================================================
 */
export async function sendVoiceMessage(): Promise<never> {
  throw new Error(
    "sendVoiceMessage is intentionally disabled. Voice streaming will be reattached after text streaming is stable.",
  );
}

/**
 * ======================================================
 * SPEECH TO TEXT (NON-STREAMING)
 * ======================================================
 */
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

  if (!res.ok) {
    throw new Error("Transcription failed");
  }

  const data = await res.json();
  return data.transcript;
}

/**
 * ======================================================
 * TEXT TO SPEECH (STREAMING AUDIO)
 * ======================================================
 */
export async function streamTTS(
  text: string,
  onAudioChunk: (base64: string) => void,
): Promise<void> {
  const sessionId = getSessionId();

  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });

  if (!res.ok) {
    throw new Error("TTS failed");
  }

  const reader = res.body?.getReader();
  if (!reader) return;

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
        if (event.type === "audio") {
          onAudioChunk(event.data);
        }
      } catch {
        // Ignore malformed chunks
      }
    }
  }
}

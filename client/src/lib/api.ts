/**
 * ======================================================
 * CLIENT API — INTERLOOP
 * Streaming-safe, server-aligned
 * ======================================================
 */

/**
 * ------------------------------------------------------
 * CREATE CONVERSATION
 * ------------------------------------------------------
 */
export async function createConversation(): Promise<{ id: number }> {
  const res = await fetch("/api/conversations", { method: "POST" });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

/**
 * ------------------------------------------------------
 * SEND MESSAGE (TEXT — STREAMING SSE)
 * ------------------------------------------------------
 */
export async function sendMessage(
  conversationId: number,
  content: string,
  onChunk: (text: string) => void,
): Promise<string> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
  let fullResponse = "";

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
          fullResponse += event.content;
          onChunk(event.content);
        }

        if (event.done) {
          return event.fullContent || fullResponse;
        }
      } catch {
        // Ignore malformed SSE chunks
      }
    }
  }

  return fullResponse;
}

/**
 * ------------------------------------------------------
 * VOICE MESSAGE (TEMP STUB — PREVENTS RUNTIME CRASH)
 * ------------------------------------------------------
 * This exists ONLY because some UI code still imports it.
 * Voice streaming will be reattached later.
 */
export async function sendVoiceMessage(): Promise<never> {
  throw new Error(
    "sendVoiceMessage is not implemented yet. Voice streaming will be reattached after text streaming is stable."
  );
}

/**
 * ------------------------------------------------------
 * SPEECH TO TEXT (NON-STREAMING)
 * ------------------------------------------------------
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
 * ------------------------------------------------------
 * TEXT TO SPEECH (STREAMING AUDIO)
 * ------------------------------------------------------
 */
export async function streamTTS(
  text: string,
  onAudioChunk: (base64: string) => void,
): Promise<void> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
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
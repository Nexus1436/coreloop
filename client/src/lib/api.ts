// client/src/lib/api.ts
// (or wherever your existing createConversation/sendMessage file lives)

type ChatRole = "user" | "assistant" | "system";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

function base64FromBlob(audioBlob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data:audio/...;base64,AAAA
      const parts = result.split(",");
      if (parts.length < 2)
        return reject(new Error("Invalid base64 audio data"));
      resolve(parts[1]);
    };
    reader.onerror = () => reject(new Error("Failed to read audio blob"));
    reader.readAsDataURL(audioBlob);
  });
}

async function throwIfResNotOk(res: Response) {
  if (res.ok) return;
  const text = (await res.text()) || res.statusText;
  throw new Error(`${res.status}: ${text}`);
}

async function safeJson<T = any>(res: Response): Promise<T> {
  // Helps you avoid "Unexpected token '<'" with a clearer error message
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Expected JSON but got non-JSON response (first 200 chars): ${text.slice(0, 200)}`,
    );
  }
}

/**
 * IMPORTANT:
 * Your backend currently has /api/chat working.
 * Your UI was trying /api/conversations + streaming endpoints that may not exist.
 *
 * We keep the same exports the UI expects, but route text chat through /api/chat
 * so the UI works immediately.
 */

export async function createConversation(): Promise<{ id: number }> {
  // If your backend does NOT implement /api/conversations, this must NOT call it.
  // The UI just needs an id to proceed.
  // Use a stable-ish id so refresh doesn't break.
  const existing = Number(localStorage.getItem("interloop_conversation_id"));
  if (existing && Number.isFinite(existing)) return { id: existing };

  const id = Date.now(); // simple unique id client-side for now
  localStorage.setItem("interloop_conversation_id", String(id));
  return { id };
}

export async function sendMessage(
  _conversationId: number,
  content: string,
  onChunk: (text: string) => void,
): Promise<string> {
  // NON-STREAMING path, but we still satisfy onChunk() so UI renders
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content } satisfies ChatMessage],
    }),
  });

  await throwIfResNotOk(res);

  // Your backend returns: { message: "..." }
  const data = await safeJson<{ message: string }>(res);

  const full = data?.message ?? "";
  if (full) onChunk(full);
  return full;
}

/**
 * Voice endpoint: only works if your backend supports:
 * POST /api/conversations/:id/voice  (SSE stream)
 *
 * If it’s not implemented, this will throw a clear error instead of hanging.
 */
export async function sendVoiceMessage(
  conversationId: number,
  audioBlob: Blob,
  callbacks: {
    onUserTranscript?: (text: string) => void;
    onTranscript?: (text: string) => void;
    onDone?: (transcript: string) => void;
  },
): Promise<string> {
  const base64Audio = await base64FromBlob(audioBlob);

  const res = await fetch(`/api/conversations/${conversationId}/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: base64Audio }),
  });

  await throwIfResNotOk(res);

  const streamReader = res.body?.getReader();
  if (!streamReader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let fullTranscript = "";

  while (true) {
    const { done, value } = await streamReader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "user_transcript") {
          callbacks.onUserTranscript?.(event.data);
        }
        if (event.type === "transcript") {
          fullTranscript += event.data;
          callbacks.onTranscript?.(event.data);
        }
        if (event.type === "done") {
          callbacks.onDone?.(event.transcript);
          return event.transcript;
        }
      } catch {
        // ignore malformed chunk
      }
    }
  }

  return fullTranscript;
}

/**
 * STT endpoint: only works if backend supports:
 * POST /api/stt -> { transcript }
 */
export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const base64Audio = await base64FromBlob(audioBlob);

  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: base64Audio }),
  });

  await throwIfResNotOk(res);

  const data = await safeJson<{ transcript: string }>(res);
  return data.transcript;
}

/**
 * TTS endpoint: only works if backend supports:
 * POST /api/tts (SSE stream of {type:"audio", data:"base64"})
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

  await throwIfResNotOk(res);

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
        // ignore malformed chunk
      }
    }
  }
}

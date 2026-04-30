/**
 * ======================================================
 * CLIENT API — INTERLOOP
 * Persistent Conversation Version — M3.5
 * ======================================================
 */

const API_BASE =
  window.location.protocol === "capacitor:" ||
  window.location.origin === "capacitor://localhost" ||
  window.location.hostname === "localhost" ||
  window.location.hostname === "capacitor.localhost"
    ? "https://app.getcoreloop.com"
    : "";

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
  const res = await fetch(`${API_BASE}/api/chat`, {
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
  console.log("transcribeAudio stage:", {
    stage: "input-blob",
    size: audioBlob.size,
    type: audioBlob.type,
  });

  const base64Audio = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const result = reader.result as string;
        console.log("transcribeAudio stage:", {
          stage: "file-reader-load",
          length: result.length,
          mod4: result.length % 4,
          mimeType: audioBlob.type,
        });

        const encoded = result.split(",")[1];

        console.log("transcribeAudio stage:", {
          stage: "base64-extracted",
          length: encoded.length,
          mod4: encoded.length % 4,
          mimeType: audioBlob.type,
        });

        resolve(encoded);
      } catch (error) {
        console.error("transcribeAudio error:", {
          stage: "file-reader-load-handler",
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        });
        reject(error);
      }
    };

    reader.onerror = () => {
      const error = reader.error ?? new Error("FileReader failed");
      console.error("transcribeAudio error:", {
        stage: "file-reader-error",
        name: error.name,
        message: error.message,
      });
      reject(error);
    };

    console.log("transcribeAudio stage:", {
      stage: "file-reader-start",
      size: audioBlob.size,
      type: audioBlob.type,
    });

    reader.readAsDataURL(audioBlob);
  });

  console.log("transcribeAudio stage:", {
    stage: "fetch-start",
    length: base64Audio.length,
    mod4: base64Audio.length % 4,
    mimeType: audioBlob.type,
  });

  const url = `${API_BASE}/api/stt`;
  const resolvedUrl = new URL(url, window.location.href).toString();

  console.log("transcribeAudio stage:", {
    stage: "request-prepare",
    url,
    resolvedUrl,
    length: base64Audio.length,
    mod4: base64Audio.length % 4,
    mimeType: audioBlob.type,
  });

  let payload: string;

  try {
    payload = JSON.stringify({
      audio: base64Audio,
      mimeType: audioBlob.type || "audio/mp4",
    });

    console.log("transcribeAudio stage:", {
      stage: "json-stringify-success",
      payloadLength: payload.length,
    });
  } catch (error) {
    console.error("transcribeAudio error:", {
      stage: "json-stringify",
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }

  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: payload,
    });

    console.log("transcribeAudio stage:", {
      stage: "fetch-returned",
      status: res.status,
      statusText: res.statusText,
      contentType: res.headers.get("content-type"),
    });
  } catch (error) {
    console.error("transcribeAudio error:", {
      stage: "fetch-throw",
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }

  let responseText: string;

  try {
    responseText = await res.text();

    console.log("transcribeAudio stage:", {
      stage: "response-text",
      status: res.status,
      contentType: res.headers.get("content-type"),
      responseLength: responseText.length,
    });
  } catch (error) {
    console.error("transcribeAudio error:", {
      stage: "response-text",
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }

  if (!res.ok) {
    console.error("transcribeAudio error:", {
      stage: "fetch-response",
      status: res.status,
      statusText: res.statusText,
    });
    throw new Error("Transcription failed");
  }

  let data: any;

  try {
    data = JSON.parse(responseText);
  } catch (error) {
    console.error("transcribeAudio error:", {
      stage: "response-json-parse",
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      responseLength: responseText.length,
    });
    throw error;
  }

  return typeof data?.transcript === "string" ? data.transcript : "";
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
   TTS (Full response playback)
====================================================== */

export async function streamTTS(
  text: string,
  onChunk: (audioChunk: string) => void,
  options?: { voice?: string },
): Promise<void> {
  if (!text || !text.trim()) return;

  const voice = options?.voice ?? "female";
  const fullText = text.trim();

  try {
    console.log("TTS_REQUEST_START", {
      length: fullText.length,
      voice,
    });

    const res = await fetch(`${API_BASE}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        text: fullText,
        voice,
      }),
    });

    const responseText = await res.text();

    if (!res.ok) {
      console.error("TTS request failed:", {
        status: res.status,
        statusText: res.statusText,
        body: responseText.slice(0, 300),
      });
      throw new Error(`TTS failed: ${res.status}`);
    }

    const data = JSON.parse(responseText);

    if (!data?.audio || typeof data.audio !== "string") {
      console.error("Invalid TTS response:", {
        keys: Object.keys(data ?? {}),
      });
      throw new Error("Invalid TTS response");
    }

    const normalized = normalizeBase64Audio(data.audio);

    if (!normalized) {
      console.error("TTS audio normalization failed");
      throw new Error("TTS audio normalization failed");
    }

    console.log("TTS_RESPONSE_RECEIVED", {
      audioLength: normalized.length,
    });

    onChunk(normalized);
  } catch (err) {
    console.error("TTS_FAIL", err);
    throw err;
  }
}

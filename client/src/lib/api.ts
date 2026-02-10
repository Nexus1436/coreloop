import { QueryClient, QueryFunction } from "@tanstack/react-query";

/* -------------------------
   Shared helpers
-------------------------- */

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

/* -------------------------
   Basic request helper
-------------------------- */

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

/* -------------------------
   React Query helpers
-------------------------- */

type UnauthorizedBehavior = "returnNull" | "throw";

export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401 }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (on401 === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

/* -------------------------
   Conversations
-------------------------- */

export async function createConversation(): Promise<{ id: number }> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res.json();
}

/* -------------------------
   CHAT — STREAMING
   (THIS IS THE MISSING EXPORT)
-------------------------- */

export async function sendMessage(
  conversationId: number,
  content: string,
  onChunk: (text: string) => void,
): Promise<string> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ content }),
  });

  await throwIfResNotOk(res);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

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
        // ignore malformed chunk
      }
    }
  }

  return fullResponse;
}

/* -------------------------
   VOICE → CHAT (STREAM)
-------------------------- */

export async function sendVoiceMessage(
  conversationId: number,
  audioBlob: Blob,
  callbacks: {
    onUserTranscript?: (text: string) => void;
    onTranscript?: (text: string) => void;
    onDone?: (transcript: string) => void;
  },
): Promise<string> {
  const base64Audio = await blobToBase64(audioBlob);

  const res = await fetch(`/api/conversations/${conversationId}/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ audio: base64Audio }),
  });

  await throwIfResNotOk(res);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let fullTranscript = "";

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

/* -------------------------
   STT (non-stream)
-------------------------- */

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  const base64Audio = await blobToBase64(audioBlob);

  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ audio: base64Audio }),
  });

  await throwIfResNotOk(res);
  const data = await res.json();
  return data.transcript;
}

/* -------------------------
   TTS (stream)
-------------------------- */

export async function streamTTS(
  text: string,
  onAudioChunk: (base64: string) => void,
): Promise<void> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
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

/* -------------------------
   Utils
-------------------------- */

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.readAsDataURL(blob);
  });
}

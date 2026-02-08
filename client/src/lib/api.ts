export async function createConversation(): Promise<{ id: number }> {
  const res = await fetch("/api/conversations", { method: "POST" });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

export async function sendMessage(
  conversationId: number,
  content: string,
  onChunk: (text: string) => void
): Promise<string> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) throw new Error("Failed to send message");

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
      } catch {}
    }
  }

  return fullResponse;
}

export async function sendVoiceMessage(
  conversationId: number,
  audioBlob: Blob,
  callbacks: {
    onUserTranscript?: (text: string) => void;
    onTranscript?: (text: string) => void;
    onDone?: (transcript: string) => void;
  }
): Promise<string> {
  const base64Audio = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.readAsDataURL(audioBlob);
  });

  const res = await fetch(`/api/conversations/${conversationId}/voice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: base64Audio }),
  });

  if (!res.ok) throw new Error("Failed to send voice message");

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
      } catch {}
    }
  }

  return fullTranscript;
}

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
  return data.transcript;
}

export async function streamTTS(
  text: string,
  onAudioChunk: (base64: string) => void
): Promise<void> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) throw new Error("TTS failed");

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
      } catch {}
    }
  }
}

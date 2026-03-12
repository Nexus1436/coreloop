import { useState, useRef, useCallback, useMemo, useEffect } from "react";

import { CentralForm } from "@/components/central-form";
import { ChatView } from "@/components/chat-view";
import { transcribeAudio, streamTTS } from "@/lib/api";
import { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

let messageCounter = 0;
function nextId() {
  return String(++messageCounter);
}

/* =====================================================
   STREAM MERGE FIX
   Prevents duplicated SSE token overlaps
===================================================== */

function mergeStream(existing: string, incoming: string) {
  const maxOverlap = Math.min(existing.length, incoming.length);

  for (let i = maxOverlap; i > 0; i--) {
    if (existing.endsWith(incoming.slice(0, i))) {
      return existing + incoming.slice(i);
    }
  }

  return existing + incoming;
}

/* =====================================================
   STREAM CHAT
===================================================== */

async function sendChat(
  conversationId: number | null,
  userText: string,
  onConversationId: (id: number) => void,
  onChunk: (chunk: string) => void,
) {
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      conversationId: conversationId ?? undefined,
      messages: [{ role: "user", content: userText }],
    }),
  });

  if (!resp.ok || !resp.body) {
    throw new Error("Chat failed");
  }

  const reader = resp.body.getReader();
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

      try {
        const obj = JSON.parse(line.slice(5));

        if (obj?.meta?.conversationId) {
          const id = Number(obj.meta.conversationId);
          if (Number.isFinite(id)) {
            onConversationId(id);
          }
        }

        if (obj?.content) {
          onChunk(obj.content);
        }

        if (obj?.done) {
          reader.cancel();
          return;
        }
      } catch {}
    }
  }
}

/* =====================================================
   COMPONENT
===================================================== */

export default function Home() {
  const [mode, setMode] = useState<"A" | "B">("A");

  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationIdRef = useRef<number | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [voiceGender, setVoiceGender] = useState<"male" | "female">("female");

  const playback = useAudioPlayback();
  const stopRequestedRef = useRef(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const lastResponse = useMemo(() => {
    const assistant = messages.filter((m) => m.role === "assistant");
    return assistant.length ? assistant[assistant.length - 1].text : null;
  }, [messages]);

  /* =====================================================
     LOAD LATEST CONVERSATION
  ===================================================== */

  useEffect(() => {
    async function loadLatestConversation() {
      try {
        const resp = await fetch("/api/conversations", {
          credentials: "include",
        });

        if (!resp.ok) return;

        const data = await resp.json();
        const convs = data?.conversations;

        if (!Array.isArray(convs) || convs.length === 0) return;

        const latestId = Number(convs[0].id);
        if (!Number.isFinite(latestId)) return;

        const msgResp = await fetch(`/api/conversations/${latestId}/messages`, {
          credentials: "include",
        });

        if (!msgResp.ok) return;

        const msgData = await msgResp.json();
        const rows = msgData?.messages;

        if (!Array.isArray(rows)) return;

        conversationIdRef.current = latestId;
        setConversationId(latestId);

        setMessages(
          rows.map((m: any) => ({
            id: String(m.id),
            role: m.role,
            text: m.content,
          })),
        );
      } catch (err) {
        console.error("Load conversation failed:", err);
      }
    }

    loadLatestConversation();
  }, []);

  /* =====================================================
     SPEAKING STATE SYNC
  ===================================================== */

  useEffect(() => {
    if (playback.state === "ended" || playback.state === "idle") {
      setIsSpeaking(false);
    }
  }, [playback.state]);

  /* =====================================================
     RECORDING
  ===================================================== */

  const startRecording = async () => {
    stopRequestedRef.current = true;
    playback.stop();
    setIsSpeaking(false);

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const recorder = new MediaRecorder(stream);

    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };

    recorder.start();
    setIsRecording(true);
  };

  const stopRecording = async (): Promise<Blob> => {
    const recorder = mediaRecorderRef.current;

    if (!recorder) return new Blob();

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    recorder.stream.getTracks().forEach((t) => t.stop());

    setIsRecording(false);

    return new Blob(chunksRef.current, { type: "audio/webm" });
  };

  /* =====================================================
     TAP FLOW
  ===================================================== */

  const handleTap = async () => {
    if (isSpeaking) {
      stopRequestedRef.current = true;
      playback.stop();
      setIsSpeaking(false);
      setIsProcessing(false);
      return;
    }

    if (isProcessing) return;

    if (!isRecording) {
      try {
        await startRecording();
      } catch (err) {
        console.error("Mic failed:", err);
      }
      return;
    }

    setIsProcessing(true);

    try {
      const blob = await stopRecording();
      const transcript = await transcribeAudio(blob);

      if (!transcript) {
        setIsProcessing(false);
        return;
      }

      const userId = nextId();
      const assistantId = nextId();

      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", text: transcript },
        { id: assistantId, role: "assistant", text: "" },
      ]);

      let assistantText = "";

      await sendChat(
        conversationIdRef.current,
        transcript,
        (id) => {
          conversationIdRef.current = id;
          setConversationId(id);
        },
        (chunk) => {
          assistantText = mergeStream(assistantText, chunk);

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, text: assistantText } : m,
            ),
          );
        },
      );

      if (!assistantText.trim()) {
        setIsProcessing(false);
        return;
      }

      await playback.init();

      stopRequestedRef.current = false;
      setIsSpeaking(true);

      try {
        await streamTTS(
          assistantText,
          (audioChunk: string) => {
            if (!stopRequestedRef.current) {
              playback.pushAudio(audioChunk);
            }
          },
          { voice: voiceGender },
        );

        if (!stopRequestedRef.current) {
          playback.signalComplete();
        }
      } catch (err) {
        console.error("TTS error:", err);
      }
    } catch (err) {
      console.error("Flow failed:", err);
    } finally {
      setIsProcessing(false);
    }
  };

  /* =====================================================
     REPEAT
  ===================================================== */

  const handleRepeat = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();

      if (!lastResponse) return;

      await playback.init();

      stopRequestedRef.current = false;
      setIsSpeaking(true);

      try {
        await streamTTS(
          lastResponse,
          (audioChunk: string) => {
            if (!stopRequestedRef.current) {
              playback.pushAudio(audioChunk);
            }
          },
          { voice: voiceGender },
        );

        if (!stopRequestedRef.current) {
          playback.signalComplete();
        }
      } catch (err) {
        console.error("Repeat TTS error:", err);
      }
    },
    [lastResponse, voiceGender, playback],
  );

  /* =====================================================
     MODE B
  ===================================================== */

  if (mode === "B") {
    return (
      <ChatView
        messages={messages}
        setMessages={setMessages}
        onBack={() => setMode("A")}
        playback={playback}
        voiceGender={voiceGender}
        lastAudioChunksRef={{ current: [] }}
      />
    );
  }

  /* =====================================================
     MAIN UI
  ===================================================== */

  return (
    <div className="min-h-screen w-full bg-black flex flex-col items-center justify-center relative">
      <div className="relative mb-12">
        <CentralForm isActive={isRecording} isDimmed={false} />

        <button
          onClick={() => {
            if (isSpeaking) {
              stopRequestedRef.current = true;
              playback.stop();
              setIsSpeaking(false);
              setIsProcessing(false);
              return;
            }

            handleTap();
          }}
          className="absolute inset-0 flex items-center justify-center"
        >
          <span className="text-sm text-gray-400">
            {isSpeaking
              ? "Stop"
              : isRecording
                ? "Listening..."
                : isProcessing
                  ? "Reflecting..."
                  : "Press here"}
          </span>
        </button>
      </div>

      <div className="absolute bottom-12 left-0 right-0 flex justify-between px-8">
        <div onClick={() => setMode("B")}>
          <p className="text-lg text-gray-500 hover:text-white">
            Prefer typing?
          </p>
        </div>

        <button
          onClick={() =>
            setVoiceGender((prev) => (prev === "male" ? "female" : "male"))
          }
          className="text-sm text-gray-400 hover:text-white"
        >
          Voice: {voiceGender}
        </button>

        {lastResponse ? (
          <div onClick={handleRepeat}>
            <p className="text-lg text-gray-500 hover:text-white">
              Repeat response
            </p>
          </div>
        ) : (
          <div />
        )}
      </div>
    </div>
  );
}

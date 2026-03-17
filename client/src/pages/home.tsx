import { useState, useRef, useEffect, useCallback } from "react";

import { CentralForm } from "@/components/central-form";
import { ChatView } from "@/components/chat-view";

import { transcribeAudio, streamTTS } from "@/lib/api";

import { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";
import { useVoiceRecorder } from "../../replit_integrations/audio/useVoiceRecorder";

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

let messageCounter = 0;
function nextId() {
  return String(++messageCounter);
}

function mergeStream(existing: string, incoming: string) {
  const maxOverlap = Math.min(existing.length, incoming.length);

  for (let i = maxOverlap; i > 0; i--) {
    if (existing.endsWith(incoming.slice(0, i))) {
      return existing + incoming.slice(i);
    }
  }

  return existing + incoming;
}

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

  if (!resp.ok || !resp.body) throw new Error("Chat failed");

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
      if (line === "data: [DONE]") return;

      try {
        const obj = JSON.parse(line.slice(5));

        if (obj?.meta?.conversationId) {
          const id = Number(obj.meta.conversationId);
          if (Number.isFinite(id)) onConversationId(id);
        }

        if (obj?.content) onChunk(obj.content);

        if (obj?.done) {
          reader.cancel();
          return;
        }
      } catch {}
    }
  }
}

export default function Home() {
  const [mode, setMode] = useState<"A" | "B">("A");

  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationIdRef = useRef<number | null>(null);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasExchanged, setHasExchanged] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [voiceGender, setVoiceGender] = useState<"male" | "female">("female");
  const voiceGenderRef = useRef(voiceGender);

  useEffect(() => {
    voiceGenderRef.current = voiceGender;
  }, [voiceGender]);

  const playback = useAudioPlayback();
  const recorder = useVoiceRecorder();

  const stopRequestedRef = useRef(false);
  const playbackStateRef = useRef(playback.state);

  const lastSpokenTextRef = useRef<string>("");
  const lastAudioChunksRef = useRef<string[]>([]);

  /* ================= LOAD PREVIOUS CONVERSATION ================= */
  useEffect(() => {
    async function loadConversation() {
      try {
        let conversationIdToUse: number | null = null;

        const storedId = localStorage.getItem("conversationId");

        if (storedId && Number.isFinite(Number(storedId))) {
          conversationIdToUse = Number(storedId);
        } else {
          const resp = await fetch("/api/conversations", {
            credentials: "include",
          });

          if (!resp.ok) return;

          const data = await resp.json();
          const convs = data?.conversations;

          if (!Array.isArray(convs) || convs.length === 0) return;

          const latestId = Number(convs[0].id);
          if (!Number.isFinite(latestId)) return;

          conversationIdToUse = latestId;
        }

        const msgResp = await fetch(
          `/api/conversations/${conversationIdToUse}/messages`,
          { credentials: "include" },
        );

        if (!msgResp.ok) return;

        const msgData = await msgResp.json();
        const rows = msgData?.messages;

        if (!Array.isArray(rows)) return;

        conversationIdRef.current = conversationIdToUse;
        setConversationId(conversationIdToUse);
        localStorage.setItem("conversationId", String(conversationIdToUse));

        const loaded = rows.map((m: any) => ({
          id: String(m.id),
          role: m.role,
          text: m.content,
        }));

        setMessages(loaded);

        messageCounter = loaded.length; // ✅ FIX #1

        if (loaded.some((m) => m.role === "user")) {
          setHasExchanged(true);
        }
      } catch (err) {
        console.error("Load conversation failed:", err);
      }
    }

    loadConversation();
  }, []);

  useEffect(() => {
    playbackStateRef.current = playback.state;

    if (playback.state === "ended" || playback.state === "idle") {
      setIsSpeaking(false);
    }
  }, [playback.state]);

  const waitForPlaybackToFinish = useCallback(async () => {
    while (
      playbackStateRef.current === "playing" &&
      !stopRequestedRef.current
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }, []);

  const stopSpeech = useCallback(() => {
    stopRequestedRef.current = true;
    playback.stop();
    setIsSpeaking(false);
    setIsProcessing(false);
    setIsRecording(false);
  }, [playback]);

  const speakText = useCallback(
    async (text: string) => {
      if (!text?.trim()) return;

      lastSpokenTextRef.current = text;

      stopRequestedRef.current = false;

      await playback.init();
      playback.stop();

      setIsSpeaking(true);

      try {
        await streamTTS(
          text,
          (chunk) => {
            if (!stopRequestedRef.current) {
              playback.pushAudio(chunk);
            }
          },
          { voice: voiceGenderRef.current },
        );

        if (!stopRequestedRef.current) {
          playback.signalComplete();
        }

        await waitForPlaybackToFinish();
      } catch (err) {
        console.error("TTS failed:", err);
      } finally {
        if (!stopRequestedRef.current) {
          setIsSpeaking(false);
        }
      }
    },
    [playback, waitForPlaybackToFinish],
  );

  const runCaseReview = async () => {
    if (isProcessing || isRecording || isSpeaking) return;

    setIsProcessing(true);

    const userId = nextId();
    const assistantId = nextId();

    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text: "Case review requested." },
      { id: assistantId, role: "assistant", text: "" },
    ]);

    let assistantText = "";

    try {
      await sendChat(
        conversationIdRef.current,
        "Case review",
        (id) => {
          conversationIdRef.current = id;
          setConversationId(id);
          localStorage.setItem("conversationId", String(id));
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

      lastSpokenTextRef.current = assistantText; // ✅ FIX #2

      setIsProcessing(false);

      if (assistantText.trim()) {
        await speakText(assistantText);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleTap = useCallback(async () => {
    if (isSpeaking) {
      stopSpeech();
      return;
    }

    if (isProcessing) return;

    if (!isRecording) {
      await playback.init();
      await recorder.startRecording();
      setIsRecording(true);
      return;
    }

    setIsRecording(false);
    setIsProcessing(true);

    try {
      const blob = await recorder.stopRecording();
      const transcript = await transcribeAudio(blob);

      if (!transcript) return;

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
          localStorage.setItem("conversationId", String(id));
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

      lastSpokenTextRef.current = assistantText; // ✅ FIX #2

      setHasExchanged(true);
      setIsProcessing(false);

      if (assistantText.trim()) {
        await speakText(assistantText);
      }
    } finally {
      setIsProcessing(false);
      setIsRecording(false);
    }
  }, [
    isSpeaking,
    isProcessing,
    isRecording,
    recorder,
    speakText,
    stopSpeech,
    playback,
  ]);

  return (
    <div className="min-h-screen w-full bg-black relative overflow-hidden">
      {mode === "A" ? (
        <>
          <div className="absolute inset-0 flex items-center justify-center pb-24">
            <div
              className="relative"
              style={{ width: "600px", height: "600px", cursor: "pointer" }}
              onClick={handleTap}
            >
              <CentralForm
                isActive={isRecording || isProcessing || isSpeaking}
                isDimmed={false}
                isSpeaking={isSpeaking}
                getAmplitude={playback.getAmplitude}
              />

              <span className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
                {isSpeaking
                  ? "Stop"
                  : isRecording
                  ? "Listening..."
                  : isProcessing
                  ? "Reflecting..."
                  : "Press here"}
              </span>
            </div>
          </div>

          {hasExchanged && (
            <div className="absolute top-4 left-4">
              <button onClick={runCaseReview}>Case review</button>
            </div>
          )}

          <div className="absolute bottom-6 left-0 right-0 flex justify-between px-8 text-gray-400 text-sm">
            <button onClick={() => setMode("B")}>Prefer typing?</button>

            <button
              onClick={() =>
                setVoiceGender((v) => (v === "female" ? "male" : "female"))
              }
            >
              Prefer {voiceGender === "female" ? "male" : "female"}
            </button>

            <button
              onClick={() => {
                if (isSpeaking) {
                  stopSpeech();
                } else if (lastSpokenTextRef.current) {
                  speakText(lastSpokenTextRef.current);
                }
              }}
            >
              {isSpeaking ? "Stop" : "Repeat response"}
            </button>
          </div>
        </>
      ) : (
        <ChatView
          messages={messages}
          setMessages={setMessages}
          playback={playback}
          voiceGender={voiceGender}
          onBack={() => setMode("A")}
          lastAudioChunksRef={lastAudioChunksRef}
        />
      )}
    </div>
  );
}
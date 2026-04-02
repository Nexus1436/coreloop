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
  isCaseReview: boolean = false,
) {
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      conversationId: conversationId ?? undefined,
      messages: [{ role: "user", content: userText }],
      isCaseReview,
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

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasExchanged, setHasExchanged] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [voiceGender, setVoiceGender] = useState<"male" | "female">("female");
  const voiceGenderRef = useRef(voiceGender);

  const playback = useAudioPlayback();
  const recorder = useVoiceRecorder();

  const stopRequestedRef = useRef(false);
  const playbackStateRef = useRef(playback.state);

  const lastSpokenTextRef = useRef<string>("");
  const lastAudioChunksRef = useRef<string[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    voiceGenderRef.current = voiceGender;
  }, [voiceGender]);

  const playUITone = useCallback((frequency = 720, durationMs = 90) => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;

      if (!AudioCtx) return;

      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioCtx();
      }

      const ctx = audioCtxRef.current;

      if (ctx.state === "suspended") {
        void ctx.resume();
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      const now = ctx.currentTime;
      const durationSec = durationMs / 1000;
      const endTime = now + durationSec;

      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, endTime);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(endTime);
    } catch (err) {
      console.warn("UI tone failed:", err);
    }
  }, []);

  /* ================= LOAD LAST 3 CONVERSATIONS MERGED ================= */
  useEffect(() => {
    async function loadMergedHistory() {
      try {
        const resp = await fetch("/api/conversations", {
          credentials: "include",
        });

        if (!resp.ok) return;

        const convs = await resp.json();
        if (!Array.isArray(convs) || convs.length === 0) return;

        const recentIds = convs
          .map((c: any) => Number(c.id))
          .filter((id: number) => Number.isFinite(id))
          .slice(0, 3);

        const allMessages: ChatMessage[] = [];

        for (let i = recentIds.length - 1; i >= 0; i--) {
          const id = recentIds[i];

          const msgResp = await fetch(`/api/messages/${id}`, {
            credentials: "include",
          });

          if (!msgResp.ok) continue;

          const rows = await msgResp.json();

          const loaded = rows.map((m: any) => ({
            id: String(m.id),
            role: m.role,
            text: m.content,
          }));

          allMessages.push(...loaded);
        }

        setMessages(allMessages);
        messageCounter = allMessages.length;

        if (allMessages.some((m) => m.role === "user")) {
          setHasExchanged(true);
        }

        const latestId = recentIds[0];
        setConversationId(latestId);
        conversationIdRef.current = latestId;
        localStorage.setItem("conversationId", String(latestId));
      } catch (err) {
        console.error(err);
      }
    }

    loadMergedHistory();
  }, []);

  useEffect(() => {
    playbackStateRef.current = playback.state;

    if (playback.state === "ended" || playback.state === "idle") {
      setIsSpeaking(false);
    }
  }, [playback.state]);

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
          {
            voice: voiceGenderRef.current,
          },
        );

        if (!stopRequestedRef.current) {
          playback.signalComplete();
        }
      } finally {
        if (!stopRequestedRef.current) {
          setIsSpeaking(false);
        }
      }
    },
    [playback],
  );

  const runCaseReview = useCallback(async () => {
    playUITone(720);

    if (
      !conversationIdRef.current ||
      isProcessing ||
      isRecording ||
      isSpeaking
    ) {
      return;
    }

    const assistantId = nextId();

    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", text: "" },
    ]);

    setIsProcessing(true);

    let assistantText = "";

    try {
      await sendChat(
        conversationIdRef.current,
        "Run case review",
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
        true,
      );

      if (assistantText.trim()) {
        await speakText(assistantText);
      }
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, isRecording, isSpeaking, playUITone, speakText]);

  const handleTap = useCallback(async () => {
    if (isSpeaking) {
      stopSpeech();
      return;
    }

    if (isProcessing) return;

    if (!isRecording) {
      playUITone(880);
      await recorder.startRecording();
      setIsRecording(true);
      return;
    }

    playUITone(660);
    setIsRecording(false);
    setIsProcessing(true);

    const blob = await recorder.stopRecording();
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

    setHasExchanged(true);
    setIsProcessing(false);

    if (assistantText.trim()) {
      await speakText(assistantText);
    }
  }, [
    isRecording,
    isProcessing,
    isSpeaking,
    playUITone,
    recorder,
    speakText,
    stopSpeech,
  ]);

  return (
    <div className="min-h-screen w-full bg-black relative overflow-hidden">
      {mode === "A" ? (
        <>
          <div className="absolute inset-0 flex items-center justify-center pb-24">
            <div
              className="relative"
              style={{ width: "600px", height: "600px" }}
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
              <button
                onClick={runCaseReview}
                className="text-white text-sm font-medium"
              >
                Case review
              </button>
            </div>
          )}

          <div className="absolute bottom-6 left-0 right-0 flex justify-between px-8 text-gray-400 text-sm">
            <button
              onClick={() => {
                playUITone(720);
                setMode("B");
              }}
            >
              Prefer typing?
            </button>

            <button
              onClick={() => {
                playUITone(720);
                setVoiceGender((v) => (v === "female" ? "male" : "female"));
              }}
            >
              Prefer {voiceGender === "female" ? "male" : "female"}
            </button>

            <button
              onClick={() => {
                playUITone(720);

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
          playUITone={(f = 720, d = 90) => playUITone(f, d)}
          onConversationIdChange={(id) => {
            conversationIdRef.current = id;
            setConversationId(id);
            localStorage.setItem("conversationId", String(id));
          }}
        />
      )}
    </div>
  );
}

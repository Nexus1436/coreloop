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

function pickAcknowledgmentClipNumber() {
  return Math.floor(Math.random() * 6) + 1;
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

function normalizeLoadedMessages(payload: unknown): ChatMessage[] {
  const rawMessages = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { messages?: unknown[] })?.messages)
      ? ((payload as { messages?: unknown[] }).messages ?? [])
      : [];

  return rawMessages
    .map((msg, index) => {
      const role = (msg as { role?: string })?.role;
      const text =
        (msg as { text?: string; content?: string })?.text ??
        (msg as { text?: string; content?: string })?.content ??
        "";

      if ((role !== "assistant" && role !== "user") || !String(text).trim()) {
        return null;
      }

      const id =
        (msg as { id?: string | number })?.id != null
          ? String((msg as { id?: string | number }).id)
          : `loaded-${index + 1}`;

      return {
        id,
        role,
        text: String(text),
      } as ChatMessage;
    })
    .filter((msg): msg is ChatMessage => Boolean(msg));
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
  const isReplayingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const acknowledgmentTimeoutRef = useRef<number | null>(null);
  const speakSessionRef = useRef(0);
  const lastPlayableMessageRef = useRef<{ id: string; text: string } | null>(
    null,
  );
  const lastAutoPlayedMessageIdRef = useRef<string | null>(null);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    voiceGenderRef.current = voiceGender;
  }, [voiceGender]);

  useEffect(() => {
    let cancelled = false;

    const loadConversations = async () => {
      try {
        const resp = await fetch("/api/conversations", {
          credentials: "include",
        });

        if (!resp.ok) throw new Error("Failed to load conversations");

        const data = await resp.json();
        const conversations = Array.isArray(data)
          ? data
          : (data.conversations ?? []);

        const latest = conversations[0] ?? null;

        if (!latest?.id) {
          if (cancelled) return;

          conversationIdRef.current = null;
          setConversationId(null);
          setMessages([]);
          setHasExchanged(false);
          localStorage.removeItem("conversationId");
          return;
        }

        const latestId = Number(latest.id);

        if (!Number.isFinite(latestId)) {
          if (cancelled) return;

          conversationIdRef.current = null;
          setConversationId(null);
          setMessages([]);
          setHasExchanged(false);
          localStorage.removeItem("conversationId");
          return;
        }

        const msgResp = await fetch(`/api/messages/${latestId}`, {
          credentials: "include",
        });

        if (!msgResp.ok) throw new Error("Failed to load messages");

        const msgData = await msgResp.json();
        const normalizedMessages = normalizeLoadedMessages(msgData);

        if (cancelled) return;

        conversationIdRef.current = latestId;
        setConversationId(latestId);
        setMessages(normalizedMessages);
        setHasExchanged(normalizedMessages.some((m) => m.role === "user"));
        localStorage.setItem("conversationId", String(latestId));
      } catch (err) {
        console.warn("Failed to load conversations:", err);

        if (cancelled) return;

        conversationIdRef.current = null;
        setConversationId(null);
        setMessages([]);
        setHasExchanged(false);
        localStorage.removeItem("conversationId");
      }
    };

    void loadConversations();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (playback.state === "ended" || playback.state === "idle") {
      setIsSpeaking(false);
      isReplayingRef.current = false;
    }
  }, [playback.state]);

  useEffect(() => {
    return () => {
      if (acknowledgmentTimeoutRef.current != null) {
        window.clearTimeout(acknowledgmentTimeoutRef.current);
      }
    };
  }, []);

  const playUITone = useCallback((frequency = 720, durationMs = 90) => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;

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

  const playAcknowledgmentAudio = useCallback(() => {
    const clipNumber = pickAcknowledgmentClipNumber();
    const gender = voiceGenderRef.current;
    const path = `/ack/${gender}/ack_${clipNumber}.mp3`;
    const audio = new Audio(path);

    void audio.play().catch((err) => {
      console.warn("Acknowledgment audio failed:", err);
    });
  }, []);

  const stopSpeech = useCallback(() => {
    speakSessionRef.current += 1;
    stopRequestedRef.current = true;
    playback.stop();
    isReplayingRef.current = false;
    setIsSpeaking(false);
    setIsProcessing(false);
    setIsRecording(false);
  }, [playback]);

  const speakText = useCallback(
    async (
      messageId: string,
      text: string,
      mode: "auto" | "repeat" = "auto",
    ) => {
      if (!text?.trim()) return;

      if (mode === "auto" && lastAutoPlayedMessageIdRef.current === messageId) {
        return;
      }

      lastPlayableMessageRef.current = { id: messageId, text };

      if (mode === "auto") {
        lastAutoPlayedMessageIdRef.current = messageId;
      }

      const sessionId = ++speakSessionRef.current;
      stopRequestedRef.current = false;

      await playback.init();
      playback.stop();

      setIsSpeaking(true);

      try {
        await streamTTS(
          text,
          (chunk) => {
            if (stopRequestedRef.current) return;
            if (sessionId !== speakSessionRef.current) return;

            playback.pushAudio(chunk);
          },
          {
            voice: voiceGenderRef.current,
          },
        );

        if (
          !stopRequestedRef.current &&
          sessionId === speakSessionRef.current
        ) {
          playback.signalComplete();
        }
      } finally {
        if (
          !stopRequestedRef.current &&
          sessionId === speakSessionRef.current
        ) {
          setIsSpeaking(false);
          isReplayingRef.current = false;
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
        await speakText(assistantId, assistantText, "auto");
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

    if (acknowledgmentTimeoutRef.current != null) {
      window.clearTimeout(acknowledgmentTimeoutRef.current);
    }

    // acknowledgmentTimeoutRef.current = window.setTimeout(() => {
    //   playAcknowledgmentAudio();
    //   acknowledgmentTimeoutRef.current = null;
    // }, 1000);

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
      await speakText(assistantId, assistantText, "auto");
    }
  }, [
    isRecording,
    isProcessing,
    isSpeaking,
    playAcknowledgmentAudio,
    playUITone,
    recorder,
    speakText,
    stopSpeech,
  ]);

  const isPlaybackActive =
    playback.state !== "idle" && playback.state !== "ended";

  const playbackLabel = isPlaybackActive ? "Stop" : "Repeat Response";

  const handlePlaybackControl = useCallback(async () => {
    playUITone(720);

    if (isPlaybackActive) {
      stopSpeech();
      return;
    }

    const lastPlayable = lastPlayableMessageRef.current;
    if (!lastPlayable) return;
    if (isReplayingRef.current) return;

    isReplayingRef.current = true;
    await speakText(lastPlayable.id, lastPlayable.text, "repeat");
  }, [isPlaybackActive, playUITone, speakText, stopSpeech]);

  return (
    <div className="h-screen w-full bg-black relative overflow-hidden">
      {mode === "A" ? (
        <>
          <div
            className="absolute inset-0 flex flex-col justify-between px-4"
            style={{
              paddingTop: "max(env(safe-area-inset-top) + 2.5rem, 3rem)",
              paddingBottom: "max(env(safe-area-inset-bottom) + 3.5rem, 4rem)",
            }}
          >
            <div />

            <div className="flex items-center justify-center">
              <div
                className="relative mx-auto"
                style={{
                  width: "min(560px, 84vw)",
                  height: "min(560px, 84vw)",
                  maxWidth: "100%",
                }}
                onClick={handleTap}
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="relative w-full h-full">
                    <CentralForm
                      isActive={isRecording || isProcessing || isSpeaking}
                      isDimmed={false}
                      isSpeaking={isSpeaking}
                      getAmplitude={playback.getAmplitude}
                    />
                  </div>
                </div>

                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-sm text-gray-400">
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
            </div>

            <div />
          </div>
          {(hasExchanged || messages.some((m) => m.role === "user")) && (
            <div
              className="absolute left-4 z-10"
              style={{
                top: "max(env(safe-area-inset-top) + 0.75rem, 1.25rem)",
              }}
            >
              <button
                onClick={runCaseReview}
                className="text-white text-sm font-medium"
              >
                Case review
              </button>
            </div>
          )}

          <div
            className="absolute left-0 right-0 flex justify-between px-4 sm:px-8 text-gray-400 text-sm"
            style={{
              bottom: "max(env(safe-area-inset-bottom) + 1rem, 1.75rem)",
              paddingBottom: "0.5rem",
            }}
          >
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

            <button onClick={handlePlaybackControl}>{playbackLabel}</button>
          </div>
        </>
      ) : (
        <ChatView
          messages={messages}
          setMessages={setMessages}
          onBack={() => setMode("A")}
          playUITone={(f = 720, d = 90) => playUITone(f, d)}
          onConversationIdChange={(id) => {
            conversationIdRef.current = id;
            setConversationId(id);
            localStorage.setItem("conversationId", String(id));
          }}
          onPlaybackControl={handlePlaybackControl}
          playbackLabel={playbackLabel}
          onSpeakText={speakText}
          onCaseReview={runCaseReview}
        />
      )}
    </div>
  );
}

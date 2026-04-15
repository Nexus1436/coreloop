import { useState, useRef, useEffect, useCallback } from "react";

import { CentralForm } from "@/components/central-form";
import { ChatView } from "@/components/chat-view";
import {
  InterloopSettings,
  type InterloopSettingsValues,
} from "@/components/interloop-settings";

import { transcribeAudio, streamTTS } from "@/lib/api";

import { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";
import { useVoiceRecorder } from "../../replit_integrations/audio/useVoiceRecorder";

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

type DashboardData = {
  activeCaseTitle: string | null;
  investigationState: string | null;
  currentMechanism: string | null;
  currentTest: string | null;
  lastShift: string | null;
  lastCaseReviewSnippet: string | null;
  caseReviewsList: {
    id: number;
    caseId: number;
    reviewText: string;
    createdAt: string;
  }[];
};

const INTERLOOP_SETTINGS_KEY = "interloopSettings";

const defaultSettings: InterloopSettingsValues = {
  name: "",
  age: "",
  height: "",
  weight: "",
  primaryActivity: "",
  dominantHand: "",
  activityLevel: "",
  competitionLevel: "",
  voice: "male_coach",
  completed: false,
};

const defaultDashboardData: DashboardData = {
  activeCaseTitle: null,
  investigationState: null,
  currentMechanism: null,
  currentTest: null,
  lastShift: null,
  lastCaseReviewSnippet: null,
  caseReviewsList: [],
};

function isSettingsComplete(settings: InterloopSettingsValues): boolean {
  return typeof settings.name === "string" && settings.name.trim().length > 0;
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
  const [mode, setMode] = useState<"A" | "B" | "C">("A");

  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationIdRef = useRef<number | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasExchanged, setHasExchanged] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [settingsData, setSettingsData] =
    useState<InterloopSettingsValues>(defaultSettings);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [dashboardData, setDashboardData] =
    useState<DashboardData>(defaultDashboardData);

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
    try {
      const raw = localStorage.getItem(INTERLOOP_SETTINGS_KEY);

      if (!raw) {
        setSettingsData(defaultSettings);
        setIsOnboardingOpen(true);
        return;
      }

      const parsed = JSON.parse(raw) as Partial<InterloopSettingsValues>;
      const nextSettings: InterloopSettingsValues = {
        ...defaultSettings,
        ...parsed,
        completed: parsed.completed === true,
      };

      setSettingsData(nextSettings);
      setIsOnboardingOpen(!isSettingsComplete(nextSettings));
    } catch {
      setSettingsData(defaultSettings);
      setIsOnboardingOpen(true);
    }
  }, []);

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

  const loadDashboardData = useCallback(async () => {
    try {
      const resp = await fetch("/api/dashboard", {
        credentials: "include",
      });

      if (!resp.ok) throw new Error("Failed to load dashboard");

      const data = await resp.json();

      setDashboardData({
        activeCaseTitle: data?.activeCaseTitle ?? null,
        investigationState: data?.investigationState ?? null,
        currentMechanism: data?.currentMechanism ?? null,
        currentTest: data?.currentTest ?? null,
        lastShift: data?.lastShift ?? null,
        lastCaseReviewSnippet: data?.lastCaseReviewSnippet ?? null,
        caseReviewsList: data?.caseReviewsList ?? [],
      });
    } catch (err) {
      console.warn("Failed to load dashboard data:", err);
      setDashboardData(defaultDashboardData);
    }
  }, []);

  useEffect(() => {
    if (isOnboardingOpen) return;
    void loadDashboardData();
  }, [isOnboardingOpen, loadDashboardData]);

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

  const handleSaveSettings = useCallback(
    async (values: InterloopSettingsValues) => {
      const nextSettings = {
        ...values,
        completed: true,
      };

      localStorage.setItem(
        INTERLOOP_SETTINGS_KEY,
        JSON.stringify(nextSettings),
      );
      setSettingsData(nextSettings);

      await fetch("/api/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(nextSettings),
      });

      setIsOnboardingOpen(!isSettingsComplete(nextSettings));
      setIsSettingsOpen(false);
      setMode("A");
    },
    [],
  );

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
    const path = `/ack/default/ack_${clipNumber}.mp3`;
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
        await streamTTS(text, (chunk) => {
          if (stopRequestedRef.current) return;
          if (sessionId !== speakSessionRef.current) return;

          playback.pushAudio(chunk);
        });

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

      await loadDashboardData();
    } finally {
      setIsProcessing(false);
    }
  }, [
    isProcessing,
    isRecording,
    isSpeaking,
    loadDashboardData,
    playUITone,
    speakText,
  ]);

  const handleInterloopExplanation = useCallback(async () => {
    if (isProcessing || isRecording || isSpeaking) {
      return;
    }

    setMode("B");

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
        `Hi... I'm meeting you for the first time. Tell me who you are in a natural, conversational way. Do not sound clinical, instructional, or like a system explanation. Do not use numbered lists or step-by-step guidance. Make it clear that I do not need to explain things cleanly, and that I can ramble, be messy, and start with whatever feels most noticeable. Sound human, direct, and warm. Start with: "Hi... I'm Coreloop."`,
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

      if (assistantText.trim()) {
        await speakText(assistantId, assistantText, "auto");
      }
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, isRecording, isSpeaking, speakText]);

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

  const handleOpenCaseReview = useCallback(
    (review: {
      id: number;
      caseId: number;
      reviewText: string;
      createdAt: string;
    }) => {
      setMode("B");

      setMessages([
        {
          id: `review-${review.id}`,
          role: "assistant",
          text: review.reviewText,
        },
      ]);
    },
    [],
  );

  const currentInvestigationState =
    dashboardData.investigationState ?? "No active case";

  const currentStateRows = [
    {
      label: "Active Case",
      value: dashboardData.activeCaseTitle,
    },
    {
      label: "Current Mechanism",
      value: dashboardData.currentMechanism,
    },
    {
      label: "Current Test",
      value: dashboardData.currentTest,
    },
    {
      label: "Last Shift",
      value: dashboardData.lastShift,
    },
  ].filter((row) => Boolean(row.value));

  if (isOnboardingOpen) {
    return (
      <InterloopSettings
        mode="onboarding"
        initialValues={settingsData}
        onSave={handleSaveSettings}
        onClose={() => {}}
      />
    );
  }

  return (
    <>
      <div className="h-screen w-full bg-black relative overflow-hidden">
        {mode === "A" ? (
          <>
            <div
              className="absolute inset-0 flex flex-col justify-between px-4"
              style={{
                paddingTop: "max(env(safe-area-inset-top) + 2.5rem, 3rem)",
                paddingBottom:
                  "max(env(safe-area-inset-bottom) + 3.5rem, 4rem)",
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
                        ? "Tap to stop"
                        : isRecording
                          ? "Press again to send"
                          : isProcessing
                            ? "Thinking..."
                            : "Press here to talk"}
                    </span>
                  </div>
                </div>
              </div>

              <div />
            </div>

            <div
              className="absolute left-4 z-10"
              style={{
                top: "max(env(safe-area-inset-top) + 0.75rem, 1.25rem)",
              }}
            >
              <button
                onClick={() => setMode("C")}
                className="text-sm font-medium transition-colors"
                style={{ color: "#ffbf47" }}
              >
                Your Investigation
              </button>
            </div>

            <div
              className="absolute right-4 z-10"
              style={{
                top: "max(env(safe-area-inset-top) + 0.75rem, 1.25rem)",
              }}
            >
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="text-gray-400 text-sm font-medium"
                aria-label="Open your setup"
              >
                Your Setup
              </button>
            </div>

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

              <button onClick={handleInterloopExplanation}>
                Who is Coreloop?
              </button>

              <button onClick={handlePlaybackControl}>{playbackLabel}</button>
            </div>
          </>
        ) : mode === "B" ? (
          <>
            <div
              className="absolute left-4 z-10"
              style={{
                top: "max(env(safe-area-inset-top) + 0.75rem, 1.25rem)",
              }}
            >
              <button
                onClick={() => setMode("C")}
                className="text-sm font-medium transition-colors"
                style={{ color: "#ffbf47" }}
              >
                Your Investigation
              </button>
            </div>

            <div
              className="absolute right-4 z-10"
              style={{
                top: "max(env(safe-area-inset-top) + 0.75rem, 1.25rem)",
              }}
            >
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="text-gray-400 text-sm font-medium"
              >
                Your Setup
              </button>
            </div>

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
              onCaseReview={() => {}}
            />
          </>
        ) : (
          <div className="h-screen w-full bg-black flex flex-col items-center justify-center text-white px-6">
            <button
              onClick={() => {
                playUITone(720);
                setMode("A");
              }}
              className="absolute left-4 top-4 text-sm text-gray-400"
            >
              Back
            </button>

            <div className="w-full max-w-xl mx-auto flex flex-col items-center text-center">
              <h1 className="text-3xl font-semibold tracking-tight text-white">
                Your Investigation
              </h1>

              <p className="mt-4 text-sm text-gray-500">
                Run focused reviews on your current case.
              </p>

              <div className="w-full mt-10 text-left">
                <div className="flex flex-col gap-5">
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-gray-600">
                      Current State
                    </div>
                    <div className="mt-1 text-sm leading-relaxed text-gray-300">
                      {currentInvestigationState}
                    </div>
                  </div>

                  {currentStateRows.map((row) => (
                    <div key={row.label} className="w-full">
                      <div className="text-xs uppercase tracking-[0.12em] text-gray-600">
                        {row.label}
                      </div>
                      <div className="mt-1 text-sm leading-relaxed text-gray-300">
                        {row.value}
                      </div>
                    </div>
                  ))}

                  <div className="w-full mt-6">
                    <button
                      onClick={() => {
                        playUITone(720);
                        setMode("B");
                        window.setTimeout(() => {
                          void runCaseReview();
                        }, 50);
                      }}
                      className="w-full text-center py-5 transition-opacity hover:opacity-90 cursor-pointer rounded-2xl border"
                      style={{
                        borderColor: "#ffb000",
                        background:
                          "linear-gradient(180deg, rgba(255,190,32,0.18) 0%, rgba(255,140,0,0.08) 100%)",
                        boxShadow:
                          "0 0 0 1px rgba(255,176,0,0.18), 0 0 28px rgba(255,176,0,0.22), inset 0 0 24px rgba(255,190,32,0.06)",
                      }}
                    >
                      <div
                        className="text-lg font-medium"
                        style={{
                          color: "#ffc83d",
                          textShadow: "0 0 12px rgba(255,184,0,0.28)",
                        }}
                      >
                        Get New Case Review
                      </div>
                      <div className="mt-2 text-sm text-gray-400">
                        Break down the current mechanism and identify the next
                        move.
                      </div>
                    </button>
                  </div>

                  {dashboardData.caseReviewsList?.length > 0 && (
                    <div>
                      <div className="text-xs uppercase tracking-[0.12em] text-gray-600">
                        Case Reviews
                      </div>

                      <div className="mt-2 flex flex-col gap-4">
                        {dashboardData.caseReviewsList.map((review) => {
                          const preview = review.reviewText?.slice(0, 140);

                          const date = new Date(
                            review.createdAt,
                          ).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          });

                          return (
                            <button
                              key={review.id}
                              onClick={() => handleOpenCaseReview(review)}
                              className="text-left hover:opacity-80 transition"
                            >
                              <div className="text-sm text-white">
                                Case Review — {date}
                              </div>

                              <div className="text-sm text-gray-400 mt-1">
                                {preview}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {isSettingsOpen && (
        <InterloopSettings
          mode="settings"
          initialValues={settingsData}
          onSave={handleSaveSettings}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </>
  );
}

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type FormEvent,
} from "react";

import { CentralForm } from "@/components/central-form";
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
  return settings.completed === true;
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
  const [mode, setMode] = useState<"A" | "C">("A");

  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationIdRef = useRef<number | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasExchanged, setHasExchanged] = useState(false);

  const [typedText, setTypedText] = useState("");

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [settingsData, setSettingsData] =
    useState<InterloopSettingsValues>(defaultSettings);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(true);
  const [isHydratingSettings, setIsHydratingSettings] = useState(true);
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
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const typingInputRef = useRef<HTMLInputElement | null>(null);
  const hasAutoScrolledInitialRef = useRef(false);
  const previousModeRef = useRef<"A" | "C">("A");
  const lastPlayableMessageRef = useRef<{ id: string; text: string } | null>(
    null,
  );
  const lastAutoPlayedMessageIdRef = useRef<string | null>(null);

  const scrollMessagesToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const scrollEl = messageScrollRef.current;
      if (!scrollEl) return;

      scrollEl.scrollTo({
        top: scrollEl.scrollHeight,
        behavior,
      });
    },
    [],
  );

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    const scrollEl = messageScrollRef.current;
    if (!scrollEl || messages.length === 0) return;

    if (!hasAutoScrolledInitialRef.current) {
      window.requestAnimationFrame(() => {
        scrollMessagesToBottom("auto");

        window.requestAnimationFrame(() => {
          scrollMessagesToBottom("auto");
          hasAutoScrolledInitialRef.current = true;
        });
      });

      return;
    }

    const distanceFromBottom =
      scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    const shouldAutoScroll = distanceFromBottom < 140;

    if (shouldAutoScroll) {
      messageEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages, scrollMessagesToBottom]);

  useEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = mode;

    if (previousMode !== "A" && mode === "A" && messages.length > 0) {
      window.requestAnimationFrame(() => {
        scrollMessagesToBottom("auto");
      });
    }
  }, [mode, messages.length, scrollMessagesToBottom]);

  useEffect(() => {
    let cancelled = false;

    const hydrateSettings = async () => {
      setIsHydratingSettings(true);

      try {
        const resp = await fetch("/api/settings", {
          credentials: "include",
        });

        if (!resp.ok) throw new Error("Failed to load settings");

        const data = await resp.json();
        const nextSettings: InterloopSettingsValues = {
          ...defaultSettings,
          ...data,
          completed: data?.completed === true,
        };

        if (cancelled) return;

        setSettingsData(nextSettings);
        setIsOnboardingOpen(!isSettingsComplete(nextSettings));
        localStorage.setItem(
          INTERLOOP_SETTINGS_KEY,
          JSON.stringify(nextSettings),
        );
      } catch {
        try {
          const raw = localStorage.getItem(INTERLOOP_SETTINGS_KEY);

          if (!raw) {
            if (cancelled) return;

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

          if (cancelled) return;

          setSettingsData(nextSettings);
          setIsOnboardingOpen(!isSettingsComplete(nextSettings));
        } catch {
          if (cancelled) return;

          setSettingsData(defaultSettings);
          setIsOnboardingOpen(true);
        }
      } finally {
        if (!cancelled) {
          setIsHydratingSettings(false);
        }
      }
    };

    void hydrateSettings();

    return () => {
      cancelled = true;
    };
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
          hasAutoScrolledInitialRef.current = false;
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
          hasAutoScrolledInitialRef.current = false;
          return;
        }

        const msgResp = await fetch(`/api/messages/${latestId}`, {
          credentials: "include",
        });

        if (!msgResp.ok) throw new Error("Failed to load messages");

        const msgData = await msgResp.json();
        const normalizedMessages = normalizeLoadedMessages(msgData);

        if (cancelled) return;

        hasAutoScrolledInitialRef.current = false;
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
        hasAutoScrolledInitialRef.current = false;
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
        caseReviewsList: Array.isArray(data?.caseReviewsList)
          ? data.caseReviewsList
          : [],
      });
    } catch (err) {
      console.warn("Failed to load dashboard data:", err);
      setDashboardData((previous) => previous);
    }
  }, []);

  const openInvestigation = useCallback(() => {
    setMode("C");
    void loadDashboardData();
  }, [loadDashboardData]);

  useEffect(() => {
    if (isOnboardingOpen) return;
    void loadDashboardData();
  }, [isOnboardingOpen, loadDashboardData]);

  useEffect(() => {
    if (mode !== "C") return;
    void loadDashboardData();
  }, [mode, loadDashboardData]);

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

      const resp = await fetch("/api/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify(nextSettings),
      });

      if (!resp.ok) throw new Error("Failed to save settings");

      const data = await resp.json();
      const savedSettings: InterloopSettingsValues = {
        ...defaultSettings,
        ...data,
        completed: data?.completed === true,
      };

      setSettingsData(savedSettings);
      localStorage.setItem(
        INTERLOOP_SETTINGS_KEY,
        JSON.stringify(savedSettings),
      );
      setIsOnboardingOpen(!isSettingsComplete(savedSettings));
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

    setMode("A");

    const assistantId = nextId();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", text: "" },
    ]);
    setIsProcessing(true);

    try {
      const resp = await fetch("/api/coreloop-intro", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          conversationId: conversationIdRef.current ?? undefined,
        }),
      });

      if (!resp.ok) throw new Error("Coreloop intro failed");

      const data = await resp.json();
      const assistantText = String(data?.text ?? "").trim();

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, text: assistantText } : m,
        ),
      );

      if (assistantText) {
        await speakText(assistantId, assistantText, "auto");
      }
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, isRecording, isSpeaking, speakText]);

  const handleTypedSubmit = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();

      const text = typedText.trim();

      if (!text || isProcessing || isRecording || isSpeaking) {
        return;
      }

      playUITone(720);
      setTypedText("");

      const userId = nextId();
      const assistantId = nextId();

      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", text },
        { id: assistantId, role: "assistant", text: "" },
      ]);

      setIsProcessing(true);

      let assistantText = "";

      try {
        await sendChat(
          conversationIdRef.current,
          text,
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

        if (assistantText.trim()) {
          await speakText(assistantId, assistantText, "auto");
        }

        void loadDashboardData();
      } finally {
        setIsProcessing(false);
      }
    },
    [
      isProcessing,
      isRecording,
      isSpeaking,
      loadDashboardData,
      playUITone,
      speakText,
      typedText,
    ],
  );

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
    void loadDashboardData();

    if (assistantText.trim()) {
      await speakText(assistantId, assistantText, "auto");
    }
  }, [
    isRecording,
    isProcessing,
    isSpeaking,
    loadDashboardData,
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
      playUITone(720);
      setMode("A");
      hasAutoScrolledInitialRef.current = false;

      setMessages([
        {
          id: `review-${review.id}`,
          role: "assistant",
          text: review.reviewText,
        },
      ]);
    },
    [playUITone],
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

  const secondaryMangoStyle = {
    color: "rgba(255,200,61,0.92)",
    textShadow: "0 0 10px rgba(255,184,0,0.16)",
  };
  const softMangoControlStyle = {
    color: "rgba(255,200,61,0.78)",
    textShadow: "0 0 8px rgba(255,184,0,0.1)",
  };
  const brightMangoLabelStyle = {
    color: "rgba(255,200,61,0.72)",
    textShadow: "0 0 10px rgba(255,184,0,0.12)",
  };

  if (isHydratingSettings) {
    return null;
  }

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
              className="pointer-events-none absolute left-1/2 z-0 h-[46vh] w-[92vw] max-w-4xl -translate-x-1/2 rounded-full"
              style={{
                top: "38%",
                background:
                  "radial-gradient(ellipse at center, rgba(255,184,0,0.15) 0%, rgba(255,176,0,0.075) 27%, rgba(255,176,0,0.032) 50%, transparent 74%)",
                filter: "blur(30px)",
              }}
            />

            <div
              className="pointer-events-none absolute left-1/2 z-0 h-[34vh] w-[64vw] max-w-2xl -translate-x-1/2 rounded-full"
              style={{
                top: "50%",
                background:
                  "radial-gradient(ellipse at center, rgba(255,200,61,0.11) 0%, rgba(255,176,0,0.047) 44%, transparent 74%)",
                filter: "blur(19px)",
              }}
            />

            <div
              className="absolute left-4 z-20 flex items-center gap-5"
              style={{
                top: "max(env(safe-area-inset-top) + 0.75rem, 1.25rem)",
              }}
            >
              <button
                onClick={openInvestigation}
                className="text-sm font-medium transition-opacity hover:opacity-90"
                style={secondaryMangoStyle}
              >
                Your Investigation
              </button>
            </div>

            <div
              className="absolute right-4 z-20"
              style={{
                top: "max(env(safe-area-inset-top) + 0.75rem, 1.25rem)",
              }}
            >
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="text-sm font-medium transition-opacity hover:opacity-90"
                style={softMangoControlStyle}
                aria-label="Open your setup"
              >
                Your Setup
              </button>
            </div>

            <div
              ref={messageScrollRef}
              className="absolute left-0 right-0 z-10 overflow-y-auto overflow-x-hidden px-5 sm:px-8"
              style={{
                top: "max(env(safe-area-inset-top) + 3.25rem, 4rem)",
                bottom: "50vh",
                WebkitMaskImage:
                  "linear-gradient(to bottom, transparent 0%, black 9%, black 84%, rgba(0,0,0,0.72) 92%, transparent 100%)",
                maskImage:
                  "linear-gradient(to bottom, transparent 0%, black 9%, black 84%, rgba(0,0,0,0.72) 92%, transparent 100%)",
              }}
            >
              <div className="mx-auto w-full max-w-[700px] py-8">
                <div className="flex w-full flex-col gap-6">
                  {messages.length === 0 ? (
                    <div className="pb-4 text-center">
                      <div
                        className="text-sm"
                        style={{
                          color: "rgba(255,200,61,0.84)",
                          textShadow: "0 0 12px rgba(255,184,0,0.18)",
                        }}
                      >
                        Start wherever the signal is loudest.
                      </div>
                      <div className="mt-2 text-sm leading-relaxed text-gray-500">
                        Voice stays primary. Typing is here when it is easier.
                      </div>
                    </div>
                  ) : (
                    messages.map((message) => {
                      const isUser = message.role === "user";

                      return (
                        <div
                          key={message.id}
                          className={`flex items-start ${
                            isUser
                              ? "justify-end gap-2.5"
                              : "justify-start gap-3"
                          }`}
                        >
                          {!isUser && (
                            <div className="relative mt-1.5 h-9 w-9 shrink-0 rounded-full">
                              <div
                                className="absolute inset-[-5px] rounded-full"
                                style={{
                                  background:
                                    "radial-gradient(circle, rgba(255,200,61,0.12) 0%, rgba(255,176,0,0.07) 42%, transparent 72%)",
                                  boxShadow: "0 0 16px rgba(255,184,0,0.14)",
                                }}
                              />
                              <div
                                className="absolute inset-0 rounded-full border"
                                style={{
                                  borderColor: "rgba(255,200,61,0.42)",
                                  background:
                                    "linear-gradient(145deg, rgba(255,200,61,0.11), rgba(255,176,0,0.03) 42%, rgba(10,10,10,0.98))",
                                  boxShadow:
                                    "inset 0 0 10px rgba(255,200,61,0.1), 0 0 0 1px rgba(255,176,0,0.055)",
                                }}
                              />
                              <div
                                className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                                style={{
                                  background: "rgba(255,200,61,0.82)",
                                  boxShadow: "0 0 8px rgba(255,184,0,0.38)",
                                }}
                              />
                            </div>
                          )}

                          <div
                            className={`relative whitespace-pre-wrap ${
                              isUser
                                ? "order-first max-w-[58%] rounded-[8px] rounded-tr-[3px] px-4 py-3 text-right text-[13px] leading-relaxed"
                                : "max-w-[82%] rounded-[10px] rounded-tl-[3px] px-5 py-4 text-[15px] leading-7 sm:text-base"
                            }`}
                            style={
                              isUser
                                ? {
                                    color: "rgba(255,200,61,0.74)",
                                    background:
                                      "linear-gradient(180deg, rgba(255,176,0,0.06), rgba(255,176,0,0.022))",
                                    border: "1px solid rgba(255,176,0,0.105)",
                                    boxShadow:
                                      "0 10px 22px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.02)",
                                  }
                                : {
                                    color: "rgba(229,231,235,0.89)",
                                    background:
                                      "linear-gradient(180deg, rgba(18,18,18,0.98), rgba(8,8,8,0.96))",
                                    border: "1px solid rgba(255,176,0,0.15)",
                                    borderLeft:
                                      "2px solid rgba(255,200,61,0.44)",
                                    boxShadow:
                                      "0 18px 40px rgba(0,0,0,0.34), 0 0 20px rgba(255,176,0,0.04), inset 0 1px 0 rgba(255,255,255,0.035)",
                                  }
                            }
                          >
                            {!isUser && (
                              <div
                                className="pointer-events-none absolute inset-x-4 top-0 h-px"
                                style={{
                                  background:
                                    "linear-gradient(90deg, rgba(255,200,61,0.32), rgba(255,200,61,0.045), transparent)",
                                }}
                              />
                            )}
                            {message.text}
                          </div>

                          {isUser && (
                            <div className="relative mt-1 h-8 w-8 shrink-0 overflow-hidden rounded-full">
                              <div
                                className="absolute inset-0 rounded-full border"
                                style={{
                                  borderColor: "rgba(255,176,0,0.32)",
                                  background:
                                    "linear-gradient(145deg, rgba(255,176,0,0.12), rgba(22,22,22,0.95))",
                                  boxShadow:
                                    "0 0 13px rgba(255,176,0,0.08), inset 0 0 8px rgba(255,176,0,0.06)",
                                }}
                              />
                              <div
                                className="absolute inset-[5px] rounded-full"
                                style={{
                                  background:
                                    "linear-gradient(145deg, rgba(255,200,61,0.18), rgba(255,176,0,0.035), rgba(8,8,8,0.96))",
                                  boxShadow:
                                    "inset 0 0 8px rgba(255,200,61,0.08)",
                                }}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                  <div ref={messageEndRef} />
                </div>
              </div>
            </div>

            <div
              className="absolute left-0 right-0 z-10 flex items-center justify-center px-4"
              style={{
                top: "60%",
                transform: "translateY(-50%)",
              }}
            >
              <div
                className="relative mx-auto"
                style={{
                  width: "min(400px, 62vw)",
                  height: "min(400px, 62vw)",
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
                  <span
                    className="text-[15px] font-medium"
                    style={
                      isSpeaking
                        ? {
                            color: "#ffd15a",
                            textShadow: "0 0 16px rgba(255,184,0,0.46)",
                          }
                        : {
                            color: "#ffd15a",
                            textShadow: "0 0 12px rgba(255,184,0,0.32)",
                          }
                    }
                  >
                    {isSpeaking ? (
                      "Tap to stop"
                    ) : isProcessing ? (
                      "Thinking..."
                    ) : isRecording ? (
                      <div style={{ textAlign: "center" }}>
                        <div>Listening…</div>
                        <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
                          Tap to send
                        </div>
                      </div>
                    ) : (
                      <div style={{ textAlign: "center" }}>
                        <div>Tap to…</div>
                        <div style={{ fontSize: "0.9em", opacity: 0.9 }}>
                          {hasExchanged
                            ? "Continue your investigation"
                            : "Start your investigation"}
                        </div>
                      </div>
                    )}
                  </span>
                </div>
              </div>
            </div>

            <div
              className="absolute left-0 right-0 z-20 px-4 sm:px-8"
              style={{
                bottom: "max(env(safe-area-inset-bottom) + 1rem, 1.25rem)",
              }}
            >
              <div className="mx-auto w-full max-w-2xl">
                <form
                  onSubmit={handleTypedSubmit}
                  className="flex items-center gap-2 border-b"
                  style={{
                    borderColor: "rgba(255,176,0,0.34)",
                  }}
                >
                  <input
                    ref={typingInputRef}
                    value={typedText}
                    onChange={(event) => setTypedText(event.target.value)}
                    disabled={isProcessing || isRecording || isSpeaking}
                    placeholder="Type if voice is not right for this..."
                    className="min-w-0 flex-1 bg-transparent py-3 text-sm text-gray-200 outline-none placeholder:text-[rgba(255,200,61,0.48)] disabled:opacity-50"
                  />

                  <button
                    type="submit"
                    disabled={
                      !typedText.trim() ||
                      isProcessing ||
                      isRecording ||
                      isSpeaking
                    }
                    className="shrink-0 py-3 pl-3 text-sm font-medium transition-opacity disabled:opacity-35"
                    style={{
                      color: "#ffc83d",
                      textShadow: "0 0 10px rgba(255,184,0,0.22)",
                    }}
                  >
                    Send
                  </button>
                </form>

                <div
                  className="mt-4 flex justify-between text-sm"
                  style={softMangoControlStyle}
                >
                  <button
                    onClick={() => {
                      playUITone(720);
                      typingInputRef.current?.focus();
                    }}
                    className="transition-opacity hover:opacity-95"
                  >
                    Prefer typing?
                  </button>

                  <button
                    onClick={handleInterloopExplanation}
                    className="transition-opacity hover:opacity-95"
                  >
                    Who is Coreloop?
                  </button>

                  <button
                    onClick={handlePlaybackControl}
                    className="transition-opacity hover:opacity-95"
                    style={
                      isPlaybackActive
                        ? {
                            color: "#ffc83d",
                            textShadow: "0 0 10px rgba(255,184,0,0.28)",
                          }
                        : undefined
                    }
                  >
                    {playbackLabel}
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="h-screen w-full bg-black relative overflow-hidden text-white px-6">
            <div
              className="pointer-events-none absolute left-1/2 top-[20%] h-[42vh] w-[86vw] max-w-3xl -translate-x-1/2 rounded-full"
              style={{
                background:
                  "radial-gradient(ellipse at center, rgba(255,184,0,0.085) 0%, rgba(255,176,0,0.042) 42%, transparent 74%)",
                filter: "blur(30px)",
              }}
            />

            <div
              className="absolute left-4 z-20"
              style={{
                top: "max(env(safe-area-inset-top) + 0.75rem, 1.25rem)",
              }}
            >
              <button
                onClick={() => {
                  playUITone(720);
                  setMode("A");
                }}
                className="text-sm font-medium transition-opacity hover:opacity-90"
                style={secondaryMangoStyle}
              >
                Back
              </button>
            </div>

            <div className="relative z-10 flex h-full w-full flex-col items-center justify-center">
              <div className="w-full max-w-xl mx-auto flex flex-col items-center text-center">
                <h1
                  className="text-3xl font-semibold tracking-tight"
                  style={{
                    color: "#ffc83d",
                    textShadow: "0 0 14px rgba(255,184,0,0.22)",
                  }}
                >
                  Your Investigation
                </h1>

                <p className="mt-4 text-sm text-gray-500">
                  Run focused reviews on your current case.
                </p>

                <div className="w-full mt-10 text-left">
                  <div className="flex flex-col gap-5">
                    <div>
                      <div
                        className="text-xs uppercase tracking-[0.14em]"
                        style={brightMangoLabelStyle}
                      >
                        Current State
                      </div>
                      <div className="mt-1 text-sm leading-relaxed text-gray-300">
                        {currentInvestigationState}
                      </div>
                    </div>

                    {currentStateRows.map((row) => (
                      <div key={row.label} className="w-full">
                        <div
                          className="text-xs uppercase tracking-[0.12em]"
                          style={brightMangoLabelStyle}
                        >
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
                          setMode("A");
                          window.setTimeout(() => {
                            void runCaseReview();
                          }, 50);
                        }}
                        className="w-full text-center py-5 transition-opacity hover:opacity-90 cursor-pointer rounded-2xl border"
                        style={{
                          borderColor: "rgba(255,176,0,0.86)",
                          background:
                            "linear-gradient(180deg, rgba(255,190,32,0.16) 0%, rgba(255,140,0,0.07) 100%)",
                          boxShadow:
                            "0 0 0 1px rgba(255,176,0,0.15), 0 0 26px rgba(255,176,0,0.18), inset 0 0 22px rgba(255,190,32,0.05)",
                        }}
                      >
                        <div
                          className="text-lg font-medium"
                          style={{
                            color: "#ffc83d",
                            textShadow: "0 0 12px rgba(255,184,0,0.26)",
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
                        <div
                          className="text-xs uppercase tracking-[0.12em]"
                          style={brightMangoLabelStyle}
                        >
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
                                <div
                                  className="text-sm font-medium"
                                  style={{
                                    color: "rgba(255,200,61,0.86)",
                                    textShadow: "0 0 9px rgba(255,184,0,0.12)",
                                  }}
                                >
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

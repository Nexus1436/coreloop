import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type FormEvent,
} from "react";
import { Capacitor } from "@capacitor/core";

import { CentralForm } from "@/components/central-form";
import { ChatView } from "@/components/chat-view";
import {
  InterloopSettings,
  type InterloopSettingsValues,
} from "@/components/interloop-settings";

import { transcribeAudio, streamTTS } from "@/lib/api";

import { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";
import { useVoiceRecorder } from "../../replit_integrations/audio/useVoiceRecorder";

const API_BASE =
  window.location.protocol === "capacitor:" ||
  window.location.origin === "capacitor://localhost" ||
  window.location.hostname === "capacitor.localhost"
    ? "https://app.getcoreloop.com"
    : "";

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
  source?: "voice" | "typed" | "system";
}

export type ConversationThread = {
  id: number | string;
  messages: ChatMessage[];
  isCurrent?: boolean;
};

type DashboardData = {
  caseType: string | null;
  activeCaseTitle: string | null;
  currentState: string | null;
  investigationState: string | null;
  signal: string | null;
  hypothesis: string | null;
  interpretationCorrection: string | null;
  failurePrediction: string | null;
  activeLever: string | null;
  activeTest: string | null;
  nextMove: string | null;
  mechanicalEnvironment: string | null;
  dominantFailure: string | null;
  movementFamily: string | null;
  adjustment: string | null;
  currentMechanism: string | null;
  currentTest: string | null;
  lastShift: string | null;
  lastCaseReviewSnippet: string | null;
  caseReviewsList: {
    id: number;
    caseId: number;
    reviewText: string;
    createdAt: string;
    statusLabel?: string | null;
    outcomeLabel?: string | null;
  }[];
};

const INTERLOOP_SETTINGS_KEY = "interloopSettings";

const VOICE_AVATAR_MAP = {
  male_coach: "/voice-avatars/male_coach.png",
  male_pt: "/voice-avatars/male_pt.png",
  female_pilates: "/voice-avatars/female_pilates.png",
  female_yoga: "/voice-avatars/female_yoga.png",
} as const;

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
  profileImageUrl: "",
};

const defaultDashboardData: DashboardData = {
  caseType: null,
  activeCaseTitle: null,
  currentState: null,
  investigationState: null,
  signal: null,
  hypothesis: null,
  interpretationCorrection: null,
  failurePrediction: null,
  activeLever: null,
  activeTest: null,
  nextMove: null,
  mechanicalEnvironment: null,
  dominantFailure: null,
  movementFamily: null,
  adjustment: null,
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
  const url = apiUrl("/api/chat");

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      conversationId: conversationId ?? undefined,
      messages: [{ role: "user", content: userText }],
      isCaseReview,
    }),
  });

  if (!resp.ok || !resp.body) {
    const bodyText = await resp.text().catch(() => "");
    if (isCaseReview) {
      console.error("Case review chat request failed:", {
        stage: "chat_fetch",
        url,
        status: resp.status,
        body: bodyText,
      });
    }
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
        source: "system",
      } as ChatMessage;
    })
    .filter((msg): msg is ChatMessage => Boolean(msg));
}

function parseJsonResponseText(text: string, label: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `${label} returned non-JSON response: ${text.slice(0, 220)}`,
    );
  }
}

function getNestedString(source: unknown, paths: string[][]): string | null {
  for (const pathParts of paths) {
    let current: unknown = source;

    for (const part of pathParts) {
      if (!current || typeof current !== "object" || !(part in current)) {
        current = null;
        break;
      }

      current = (current as Record<string, unknown>)[part];
    }

    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
  }

  return null;
}

function normalizeBase64Audio(input: string): string {
  return String(input ?? "")
    .replace(/^data:audio\/[a-zA-Z0-9.+-]+;base64,/, "")
    .replace(/\s+/g, "")
    .trim();
}

function base64AudioToObjectUrl(base64Audio: string): string {
  const cleaned = normalizeBase64Audio(base64Audio);
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
}

export default function Home() {
  const [mode, setMode] = useState<"A" | "C">("A");

  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationIdRef = useRef<number | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [recentConversationThreads, setRecentConversationThreads] = useState<
    ConversationThread[]
  >([]);
  const [hasExchanged, setHasExchanged] = useState(false);

  const [typedText, setTypedText] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

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
  const repeatAudioRef = useRef<HTMLAudioElement | null>(null);
  const repeatAudioReleaseRef = useRef<(() => void) | null>(null);
  const repeatSessionRef = useRef(0);
  const acknowledgmentTimeoutRef = useRef<number | null>(null);
  const speakSessionRef = useRef(0);
  const typingInputRef = useRef<HTMLInputElement | null>(null);
  const lastAutoPlayedMessageIdRef = useRef<string | null>(null);
  const [isRepeatPlaying, setIsRepeatPlaying] = useState(false);
  const [activeRepeatMessageId, setActiveRepeatMessageId] = useState<
    string | null
  >(null);

  const selectedVoice =
    settingsData.voice in VOICE_AVATAR_MAP ? settingsData.voice : "male_coach";
  const selectedVoiceAvatar = VOICE_AVATAR_MAP[selectedVoice];

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

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
          profileImageUrl: data?.profileImageUrl ?? "",
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
            profileImageUrl: parsed.profileImageUrl ?? "",
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
        const conversationsUrl = apiUrl("/api/conversations");
        const resp = await fetch(conversationsUrl, {
          credentials: "include",
        });

        const responseText = await resp.text();

        if (!resp.ok) {
          throw new Error(
            `Failed to load conversations (${resp.status} ${resp.statusText}): ${responseText.slice(
              0,
              220,
            )}`,
          );
        }

        const data = parseJsonResponseText(responseText, "Conversations");
        const conversations = Array.isArray(data)
          ? data
          : Array.isArray((data as { conversations?: unknown })?.conversations)
            ? ((data as { conversations: unknown[] }).conversations)
            : ([] as unknown[]);
        const conversationRows = conversations as Array<Record<string, any>>;

        const sortedConversations = [...conversationRows].sort((a, b) => {
          const aTime = new Date(
            a?.updatedAt ?? a?.createdAt ?? a?.lastMessageAt ?? 0,
          ).getTime();
          const bTime = new Date(
            b?.updatedAt ?? b?.createdAt ?? b?.lastMessageAt ?? 0,
          ).getTime();

          if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
            return bTime - aTime;
          }

          return Number(b?.id ?? 0) - Number(a?.id ?? 0);
        });

        const latest = sortedConversations[0] ?? null;
        const priorConversations = sortedConversations.slice(1, 3);

        if (!latest?.id) {
          if (cancelled) return;

          conversationIdRef.current = null;
          setConversationId(null);
          setMessages([]);
          setRecentConversationThreads([]);
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
          setRecentConversationThreads([]);
          setHasExchanged(false);
          localStorage.removeItem("conversationId");
          return;
        }

        const priorThreadResults = await Promise.all(
          priorConversations.map(async (conversation) => {
            const id = Number(conversation?.id);
            if (!Number.isFinite(id)) return null;

            const messagesUrl = apiUrl(`/api/messages/${id}`);
            const messagesResponse = await fetch(messagesUrl, {
              credentials: "include",
            });
            const messagesText = await messagesResponse.text();

            if (!messagesResponse.ok) {
              throw new Error(
                `Failed to load prior messages (${messagesResponse.status} ${messagesResponse.statusText}): ${messagesText.slice(
                  0,
                  220,
                )}`,
              );
            }

            const messagesPayload = parseJsonResponseText(
              messagesText,
              `Messages ${id}`,
            );
            const threadMessages = normalizeLoadedMessages(messagesPayload);

            if (threadMessages.length === 0) return null;

            return {
              id,
              messages: threadMessages,
            } satisfies ConversationThread;
          }),
        );

        const latestMessagesUrl = apiUrl(`/api/messages/${latestId}`);
        const latestMessagesResponse = await fetch(latestMessagesUrl, {
          credentials: "include",
        });
        const latestMessagesText = await latestMessagesResponse.text();

        if (!latestMessagesResponse.ok) {
          throw new Error(
            `Failed to load latest messages (${latestMessagesResponse.status} ${latestMessagesResponse.statusText}): ${latestMessagesText.slice(
              0,
              220,
            )}`,
          );
        }

        const latestMessagesPayload = parseJsonResponseText(
          latestMessagesText,
          `Messages ${latestId}`,
        );
        const normalizedMessages =
          normalizeLoadedMessages(latestMessagesPayload);

        if (cancelled) return;

        conversationIdRef.current = latestId;
        setConversationId(latestId);
        setMessages(normalizedMessages);
        setRecentConversationThreads(
          priorThreadResults.filter(
            (thread): thread is ConversationThread => Boolean(thread),
          ),
        );
        setHasExchanged(normalizedMessages.some((m) => m.role === "user"));
        localStorage.setItem("conversationId", String(latestId));
      } catch (err) {
        console.warn("Failed to load conversations:", err);

        if (cancelled) return;

        conversationIdRef.current = null;
        setConversationId(null);
        setMessages([]);
        setRecentConversationThreads([]);
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
      const resp = await fetch(apiUrl("/api/dashboard"), {
        credentials: "include",
      });

      if (!resp.ok) throw new Error("Failed to load dashboard");

      const data = await resp.json();
      const signal = getNestedString(data, [
        ["signal"],
        ["currentCase", "signal"],
        ["currentCase", "latestSignal"],
        ["currentCase", "evidence", "signal"],
        ["activeCase", "signal"],
        ["activeCase", "latestSignal"],
        ["activeCase", "evidence", "signal"],
        ["caseEvidence", "signal"],
        ["evidence", "signal"],
      ]);
      const hypothesis = getNestedString(data, [
        ["hypothesis"],
        ["currentCase", "hypothesis"],
        ["currentCase", "latestHypothesis"],
        ["currentCase", "evidence", "hypothesis"],
        ["activeCase", "hypothesis"],
        ["activeCase", "latestHypothesis"],
        ["activeCase", "evidence", "hypothesis"],
        ["caseEvidence", "hypothesis"],
        ["evidence", "hypothesis"],
      ]);
      const adjustment = getNestedString(data, [
        ["activeLever"],
        ["adjustment"],
        ["currentCase", "adjustment"],
        ["currentCase", "latestAdjustment"],
        ["currentCase", "evidence", "adjustment"],
        ["activeCase", "adjustment"],
        ["activeCase", "latestAdjustment"],
        ["activeCase", "evidence", "adjustment"],
        ["caseEvidence", "adjustment"],
        ["evidence", "adjustment"],
      ]);
      const activeTest = getNestedString(data, [["activeTest"]]);
      const activeLever = getNestedString(data, [["activeLever"]]);
      const interpretationCorrection = getNestedString(data, [
        ["interpretationCorrection"],
      ]);
      const nextMove = getNestedString(data, [
        ["activeTest"],
        ["nextMove"],
        ["currentTest"],
      ]);
      const lastShift = getNestedString(data, [
        ["interpretationCorrection"],
        ["lastShift"],
      ]);

      setDashboardData({
        caseType: data?.caseType ?? null,
        activeCaseTitle: data?.activeCaseTitle ?? null,
        currentState: data?.currentState ?? null,
        investigationState: data?.investigationState ?? null,
        signal,
        hypothesis,
        interpretationCorrection,
        failurePrediction: getNestedString(data, [["failurePrediction"]]),
        activeLever,
        activeTest,
        nextMove,
        mechanicalEnvironment: getNestedString(data, [
          ["mechanicalEnvironment"],
        ]),
        dominantFailure: getNestedString(data, [["dominantFailure"]]),
        movementFamily: getNestedString(data, [["movementFamily"]]),
        adjustment: activeLever ?? adjustment,
        currentMechanism: data?.currentMechanism ?? null,
        currentTest: activeTest ?? data?.currentTest ?? null,
        lastShift,
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

      if (repeatAudioRef.current) {
        repeatAudioRef.current.pause();
        repeatAudioRef.current.currentTime = 0;
      }
    };
  }, []);

  const handleSaveSettings = useCallback(
    async (values: InterloopSettingsValues) => {
      const nextSettings = {
        ...values,
        profileImageUrl: values.profileImageUrl ?? "",
        completed: true,
      };

const resp = await fetch(`${API_BASE}/api/settings`, {
  method: "POST",
  mode: "cors",
  headers: {
    "Content-Type": "application/json",
  },
  credentials: "include",
  body: JSON.stringify(nextSettings),
});

if (!resp.ok) {
  const errorText = await resp.text().catch(() => "");
  throw new Error(`SETTINGS SAVE FAILED ${resp.status}: ${errorText}`);
}

      const data = await resp.json();
      const savedSettings: InterloopSettingsValues = {
        ...defaultSettings,
        ...data,
        profileImageUrl:
          nextSettings.profileImageUrl ?? data?.profileImageUrl ?? "",
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

  const stopRepeatPlayback = useCallback(() => {
    repeatSessionRef.current += 1;

    if (repeatAudioRef.current) {
      repeatAudioRef.current.onended = null;
      repeatAudioRef.current.onerror = null;
      repeatAudioRef.current.pause();
      repeatAudioRef.current.currentTime = 0;
      repeatAudioRef.current.src = "";

      try {
        repeatAudioRef.current.load();
      } catch {}
    }

    repeatAudioReleaseRef.current?.();
    repeatAudioReleaseRef.current = null;
    repeatAudioRef.current = null;
    setIsRepeatPlaying(false);
    setActiveRepeatMessageId(null);
  }, []);

  const stopSpeech = useCallback(() => {
    speakSessionRef.current += 1;
    stopRequestedRef.current = true;
    playback.stop();
    isReplayingRef.current = false;
    setIsSpeaking(false);
    setIsProcessing(false);
    setIsRecording(false);
    stopRepeatPlayback();
  }, [playback, stopRepeatPlayback]);

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

      if (mode === "auto") {
        lastAutoPlayedMessageIdRef.current = messageId;
      }

      const sessionId = ++speakSessionRef.current;
      stopRequestedRef.current = false;

      await playback.init();
      stopRepeatPlayback();
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
          { voice: selectedVoice },
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
    [playback, selectedVoice, stopRepeatPlayback],
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

    setMode("A");

    const assistantId = `case-review-temp-${nextId()}`;

    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", text: "", source: "system" },
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
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });

        try {
          await playMessageResponse(assistantId, assistantText);
        } catch (error) {
          console.error("Case review playback failed:", error);
        }
      }

      await loadDashboardData();
    } catch (error) {
      console.error("Case review failed:", {
        assistantId,
        assistantTextLength: assistantText.length,
        error,
      });
    } finally {
      setMessages((prev) =>
        prev.filter((message) => message.id !== assistantId),
      );
      setIsProcessing(false);
    }
  }, [
    isProcessing,
    isRecording,
    isSpeaking,
    loadDashboardData,
    playUITone,
  ]);

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
        { id: userId, role: "user", text, source: "typed" },
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
      setVoiceError("");

      try {
        await recorder.startRecording();
        setIsRecording(true);
      } catch (error) {
        console.error("Voice recording failed to start:", error);
        setVoiceError("Microphone unavailable. Check microphone permission and try again.");
      }

      return;
    }

    playUITone(660);
    setIsRecording(false);
    setVoiceError("");

    if (acknowledgmentTimeoutRef.current != null) {
      window.clearTimeout(acknowledgmentTimeoutRef.current);
    }

    setIsProcessing(true);

    try {
      const blob = await recorder.stopRecording();

      if (blob.size === 0) {
        throw new Error("No audio was recorded. Try again.");
      }

      const transcript = await transcribeAudio(blob);
      if (!transcript.trim()) {
        throw new Error("No speech was detected. Try again.");
      }

      const userId = nextId();
      const assistantId = nextId();

      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", text: transcript, source: "voice" },
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
      void loadDashboardData();

      if (assistantText.trim()) {
        await speakText(assistantId, assistantText, "auto");
      }
    } catch (error) {
      console.error("Voice flow failed:", error);
      setVoiceError(
        error instanceof Error
          ? error.message
          : "Voice processing failed. Try again.",
      );
    } finally {
      setIsProcessing(false);
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

  const resendTranscript = useCallback(
    async (text: string) => {
      const nextText = text.trim();

      if (!nextText || isProcessing || isRecording || isSpeaking) {
        return;
      }

      playUITone(720);

      const userId = nextId();
      const assistantId = nextId();

      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", text: nextText, source: "voice" },
        { id: assistantId, role: "assistant", text: "" },
      ]);

      setIsProcessing(true);

      let assistantText = "";

      try {
        await sendChat(
          conversationIdRef.current,
          nextText,
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
        void loadDashboardData();

        if (assistantText.trim()) {
          await speakText(assistantId, assistantText, "auto");
        }
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
    ],
  );

  const handleEditTranscript = useCallback(
    (message: ChatMessage) => {
      if (isProcessing || isRecording || isSpeaking) return;

      playUITone(720);
      setEditingMessageId(message.id);
      setEditingText(message.text);
    },
    [isProcessing, isRecording, isSpeaking, playUITone],
  );

  const handleCancelTranscriptEdit = useCallback(() => {
    playUITone(520);
    setEditingMessageId(null);
    setEditingText("");
  }, [playUITone]);

  const handleSubmitTranscriptEdit = useCallback(async () => {
    const nextText = editingText.trim();
    if (!nextText) return;

    setEditingMessageId(null);
    setEditingText("");
    await resendTranscript(nextText);
  }, [editingText, resendTranscript]);

  const handleRetryTranscript = useCallback(async () => {
    if (isProcessing || isRecording) return;

    if (isSpeaking) {
      stopSpeech();
    }

    playUITone(880);
    setVoiceError("");

    try {
      await recorder.startRecording();
      setIsRecording(true);
    } catch (error) {
      console.error("Voice recording failed to start:", error);
      setVoiceError(
        "Microphone unavailable. Check microphone permission and try again.",
      );
    }
  }, [
    isProcessing,
    isRecording,
    isSpeaking,
    playUITone,
    recorder,
    stopSpeech,
  ]);

  const isPlaybackActive =
    playback.state !== "idle" && playback.state !== "ended";

  const playMessageResponse = useCallback(async (messageId: string, text: string) => {
    playUITone(720);

    const tappedActiveAvatar =
      isRepeatPlaying && activeRepeatMessageId === messageId;

    if (isPlaybackActive) {
      stopSpeech();
    }

    stopRepeatPlayback();

    if (tappedActiveAvatar) {
      return;
    }

    const responseText = text.trim();

    if (!responseText) {
      console.warn("Model avatar playback skipped: empty response");
      return;
    }

    const sessionId = ++repeatSessionRef.current;
    const isNativePlayback = Capacitor.isNativePlatform();

    playback.stop();
    stopRequestedRef.current = true;
    setIsSpeaking(false);
    setIsRepeatPlaying(true);
    setActiveRepeatMessageId(messageId);

    try {
      console.log("TTS_REQUEST_START", {
        messageId,
        native: isNativePlayback,
        length: responseText.length,
      });

      const response = await fetch(apiUrl("/api/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          text: responseText,
          voice: selectedVoice,
        }),
      });

      const ttsResponseText = await response.text();

      if (!response.ok) {
        console.error("Model avatar TTS request failed:", {
          status: response.status,
          statusText: response.statusText,
          body: ttsResponseText.slice(0, 300),
        });
        throw new Error(`TTS failed: ${response.status}`);
      }

      const data = parseJsonResponseText(ttsResponseText, "Repeat TTS");
      const audio = normalizeBase64Audio(
        typeof (data as { audio?: unknown })?.audio === "string"
          ? ((data as { audio: string }).audio)
          : "",
      );

      if (!audio) {
        console.error("Model avatar TTS returned no audio:", {
          keys: Object.keys((data as Record<string, unknown>) ?? {}),
        });
        throw new Error("TTS returned no audio");
      }

      console.log("TTS_RESPONSE_RECEIVED", {
        messageId,
        native: isNativePlayback,
        audioLength: audio.length,
      });

      if (sessionId !== repeatSessionRef.current) return;

      await new Promise<void>((resolve, reject) => {
        if (sessionId !== repeatSessionRef.current) {
          resolve();
          return;
        }

        let settled = false;
        let objectUrl: string | null = null;

        const finish = () => {
          if (settled) return;
          settled = true;

          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
          }

          resolve();
        };

        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;

          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
          }

          reject(error);
        };

        const audioSource = isNativePlayback
          ? `data:audio/mpeg;base64,${audio}`
          : base64AudioToObjectUrl(audio);

        if (!isNativePlayback) {
          objectUrl = audioSource;
        }

        const player = new Audio(audioSource);
        player.preload = "auto";
        player.volume = 1;
        player.setAttribute("playsinline", "true");

        repeatAudioRef.current = player;
        repeatAudioReleaseRef.current = finish;

        player.onended = () => {
          console.log("TTS_PLAYBACK_END", {
            messageId,
            native: isNativePlayback,
          });

          if (repeatAudioRef.current === player) {
            repeatAudioRef.current = null;
            repeatAudioReleaseRef.current = null;
          }

          finish();
        };

        player.onerror = () => {
          console.error("TTS_ERROR", player.error);

          if (repeatAudioRef.current === player) {
            repeatAudioRef.current = null;
            repeatAudioReleaseRef.current = null;
            setIsRepeatPlaying(false);
            setActiveRepeatMessageId(null);
          }

          fail(player.error ?? new Error("Audio playback failed"));
        };

        console.log("TTS_PLAYBACK_START", {
          messageId,
          native: isNativePlayback,
        });

        player.play().catch((error) => {
          console.error("Model avatar audio.play failed:", error);

          if (repeatAudioRef.current === player) {
            repeatAudioRef.current = null;
            repeatAudioReleaseRef.current = null;
            setIsRepeatPlaying(false);
            setActiveRepeatMessageId(null);
          }

          fail(error);
        });
      });
    } catch (error) {
      console.error("TTS_FAIL", error);
    } finally {
      if (sessionId === repeatSessionRef.current) {
        repeatAudioReleaseRef.current?.();
        repeatAudioReleaseRef.current = null;
        repeatAudioRef.current = null;
        setIsRepeatPlaying(false);
        setActiveRepeatMessageId(null);
      }
    }
  }, [
    activeRepeatMessageId,
    isPlaybackActive,
    isRepeatPlaying,
    playback,
    playUITone,
    selectedVoice,
    stopRepeatPlayback,
    stopSpeech,
  ]);

  const handleInterloopExplanation = useCallback(async () => {
    if (isProcessing || isRecording) {
      return;
    }

    if (isSpeaking || isPlaybackActive || isRepeatPlaying) {
      stopSpeech();
      stopRepeatPlayback();
    }

    playUITone(720);
    setMode("A");

    const assistantId = nextId();

    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", text: "" },
    ]);
    setIsProcessing(true);

    try {
      const resp = await fetch(apiUrl("/api/coreloop-intro"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          conversationId: conversationIdRef.current ?? undefined,
        }),
      });

      const responseText = await resp.text();

      if (!resp.ok) {
        throw new Error(
          `Coreloop intro failed (${resp.status} ${resp.statusText}): ${responseText.slice(
            0,
            300,
          )}`,
        );
      }

      const data = parseJsonResponseText(responseText, "Coreloop intro");
      const assistantText = String(data?.text ?? "").trim();

      try {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, text: assistantText }
              : message,
          ),
        );

        setHasExchanged(true);
      } catch (error) {
        console.error("Coreloop intro message update failed:", error);
      }

      if (assistantText) {
        window.requestAnimationFrame(() => {
          try {
            void playMessageResponse(assistantId, assistantText).catch(
              (error) => {
                console.error("Coreloop intro playback failed:", error);
              },
            );
          } catch (error) {
            console.error("Coreloop intro playback failed:", error);
          }
        }, 0);
      }
    } catch (error) {
      console.error("Coreloop intro failed:", error);
    } finally {
      setIsProcessing(false);
    }
  }, [
    isPlaybackActive,
    isProcessing,
    isRepeatPlaying,
    isRecording,
    isSpeaking,
    playMessageResponse,
    playUITone,
    stopRepeatPlayback,
    stopSpeech,
  ]);

  const handleOpenCaseReview = useCallback(
    async (review: {
      id: number;
      caseId: number;
      reviewText: string;
      createdAt: string;
    }) => {
      playUITone(720);
      setMode("A");

      const assistantId = `case-review-temp-${review.id}`;
      const reviewText = String(review.reviewText ?? "").trim();

      if (!reviewText) return;

      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          text: reviewText,
          source: "system",
        },
      ]);

      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });

      try {
        await playMessageResponse(assistantId, reviewText);
      } catch (error) {
        console.error("Saved case review playback failed:", error);
      } finally {
        setMessages((prev) =>
          prev.filter((message) => message.id !== assistantId),
        );
      }
    },
    [playMessageResponse, playUITone],
  );

  const currentStateValue =
    dashboardData.currentState ??
    dashboardData.investigationState ??
    "No active case";
  const currentTestValue =
    dashboardData.activeTest ?? dashboardData.currentTest;
  const adjustmentValue =
    dashboardData.activeLever ?? dashboardData.adjustment;
  const nextMoveValue =
    dashboardData.activeTest ??
    dashboardData.nextMove ??
    dashboardData.currentTest;
  const lastShiftValue =
    dashboardData.interpretationCorrection ?? dashboardData.lastShift;
  const lastUpdatedDate = dashboardData.caseReviewsList?.[0]?.createdAt
    ? new Date(dashboardData.caseReviewsList[0].createdAt)
    : null;
  const lastUpdatedLabel =
    lastUpdatedDate && Number.isFinite(lastUpdatedDate.getTime())
      ? lastUpdatedDate.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : "Not captured yet";
  const normalizedHypothesis = String(dashboardData.hypothesis ?? "")
    .trim()
    .toLowerCase();
  const normalizedCurrentMechanism = String(
    dashboardData.currentMechanism ?? "",
  )
    .trim()
    .toLowerCase();
  const shouldShowCurrentMechanism =
    !normalizedHypothesis ||
    !normalizedCurrentMechanism ||
    normalizedHypothesis !== normalizedCurrentMechanism;
  const compactCaseRows = [
    {
      label: "Current State",
      value: currentStateValue,
    },
    {
      label: "Last Updated",
      value: lastUpdatedLabel,
    },
    {
      label: "Active Case",
      value: dashboardData.activeCaseTitle,
    },
    {
      label: "Current Test",
      value: currentTestValue,
    },
  ];
  const currentCaseRows = [
    {
      label: "Signal",
      value: dashboardData.signal,
    },
    {
      label: "Hypothesis",
      value: dashboardData.hypothesis,
    },
    ...(shouldShowCurrentMechanism
      ? [
          {
            label: "Current Mechanism",
            value: dashboardData.currentMechanism,
          },
        ]
      : []),
    {
      label: "Last Shift",
      value: lastShiftValue,
    },
    {
      label: "Risk If Unchanged",
      value: dashboardData.failurePrediction,
    },
    {
      label: "Adjustment",
      value: adjustmentValue,
    },
    {
      label: "Next Move",
      value: nextMoveValue,
    },
  ];

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
  const conversationThreads: ConversationThread[] = [
    ...recentConversationThreads,
    {
      id: conversationId ?? "current",
      messages,
      isCurrent: true,
    },
  ].filter((thread) => thread.messages.length > 0);

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
    <div
      className={
        mode === "A"
          ? "min-h-dvh w-full bg-black relative overflow-y-auto overflow-x-hidden"
          : "relative h-dvh w-full bg-black overflow-visible"
      }
    >

        {mode === "A" ? (
          <>
            <div
              className="pointer-events-none absolute left-1/2 z-0 h-[46vh] w-[92vw] max-w-4xl -translate-x-1/2 rounded-full"
              style={{
                top: "51%",
                background:
                  "radial-gradient(ellipse at center, rgba(255,184,0,0.12) 0%, rgba(255,176,0,0.06) 27%, rgba(255,176,0,0.026) 50%, transparent 74%)",
                filter: "blur(30px)",
              }}
            />

            <div
              className="pointer-events-none absolute left-1/2 z-0 h-[34vh] w-[64vw] max-w-2xl -translate-x-1/2 rounded-full"
              style={{
                top: "57%",
                background:
                  "radial-gradient(ellipse at center, rgba(255,200,61,0.095) 0%, rgba(255,176,0,0.04) 44%, transparent 74%)",
                filter: "blur(19px)",
              }}
            />

            <div
              className="fixed left-0 right-0 z-50 px-4 sm:px-8"
              style={{
                top: "calc(env(safe-area-inset-top) + 0.35rem)",
              }}
            >
              <div className="mx-auto w-full max-w-2xl flex items-center justify-between">
                <button
                  onClick={() => {
                    playUITone(720);
                    openInvestigation();
                  }}
                  className="text-sm font-medium transition-opacity hover:opacity-90"
                  style={secondaryMangoStyle}
                >
                  Your Investigation
                </button>

                <button
                  onClick={() => {
                    playUITone(720);
                    setIsSettingsOpen(true);
                  }}
                  className="text-sm font-medium transition-opacity hover:opacity-90"
                  style={softMangoControlStyle}
                  aria-label="Open your setup"
                >
                  Your Setup
                </button>
              </div>
            </div>

            <ChatView
              messages={messages}
              conversationThreads={conversationThreads}
              conversationId={conversationId}
              selectedVoiceAvatar={selectedVoiceAvatar}
              userAvatarUrl={settingsData.profileImageUrl}
              isRepeatPlaying={isRepeatPlaying}
              activeRepeatMessageId={activeRepeatMessageId}
              onPlayMessageResponse={playMessageResponse}
              editingMessageId={editingMessageId}
              editingText={editingText}
              onEditingTextChange={setEditingText}
              onCancelTranscriptEdit={handleCancelTranscriptEdit}
              onSubmitTranscriptEdit={handleSubmitTranscriptEdit}
              onEditTranscript={handleEditTranscript}
              onRetryTranscript={handleRetryTranscript}
              onResendTranscript={resendTranscript}
              isProcessing={isProcessing}
              isRecording={isRecording}
              isSpeaking={isSpeaking}
              softMangoControlStyle={softMangoControlStyle}
              secondaryMangoStyle={secondaryMangoStyle}
            />

            <div
              className="absolute left-0 right-0 z-10 flex items-center justify-center px-4"
              style={{
                top: "74%",
                transform: "translateY(-50%)",
              }}
            >
              <div
                className="relative mx-auto h-[min(370px,52vw)] w-[min(370px,52vw)] sm:h-[min(320px,42vw)] sm:w-[min(320px,42vw)]"
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

                <div className="absolute inset-0 flex items-center justify-center px-10 sm:px-14 pointer-events-none">
                  <span
                    className="text-[14px] font-medium sm:text-[16px]"
                    style={
                      isSpeaking
                        ? {
                            maxWidth: "75%",
                            textAlign: "center",
                            color: "#ffd15a",
                            textShadow: "0 0 16px rgba(255,184,0,0.46)",
                          }
                        : {
                            maxWidth: "75%",
                            textAlign: "center",
                            color: "#ffd15a",
                            textShadow: "0 0 12px rgba(255,184,0,0.32)",
                          }
                    }
                  >
                    {voiceError ? (
                      <div
                        style={{
                          textAlign: "center",
                          lineHeight: "1.3",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          transform: "translateY(-12%)",
                        }}
                      >
                        <div>{voiceError}</div>
                      </div>
                    ) : isSpeaking ? (
                      "Tap to stop"
                    ) : isProcessing ? (
                      "Thinking..."
                    ) : isRecording ? (
                      <div
                        style={{
                          textAlign: "center",
                          lineHeight: "1.25",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          transform: "translateY(-12%)",
                        }}
                      >
                        <div>Listening…</div>
                        <div style={{ fontSize: "0.85em", opacity: 0.8 }}>
                          Tap to send
                        </div>
                      </div>
                    ) : (
                      <div
                        style={{
                          textAlign: "center",
                          lineHeight: "1.25",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          transform: "translateY(-12%)",
                        }}
                      >
                        <div>Tap to…</div>
                        <div style={{ fontSize: "0.9em", opacity: 0.85 }}>
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
              className="fixed left-0 right-0 z-50 px-4 sm:px-8"
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
                </div>
              </div>
            </div>
          </>
        ) : (
          <div
            className="relative flex h-[100dvh] w-full flex-col bg-black text-white"
            style={{
              height: "100dvh",
              minHeight: "100dvh",
            }}
          >
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
                top: "calc(env(safe-area-inset-top) + 0.75rem)",
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

            <div
              className="relative z-10 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6"
              style={{
                flex: "1 1 auto",
                WebkitOverflowScrolling: "touch",
                touchAction: "pan-y",
                paddingTop: "calc(env(safe-area-inset-top) + 4.25rem)",
                paddingBottom: "calc(env(safe-area-inset-bottom) + 80px)",
              }}
            >
              <div className="w-full max-w-xl mx-auto flex flex-col items-stretch text-left">
                <h1
                  className="text-2xl font-semibold tracking-tight"
                  style={{
                    color: "#ffc83d",
                    textShadow: "0 0 14px rgba(255,184,0,0.22)",
                  }}
                >
                  Your Investigation
                </h1>

                <p className="mt-4 text-[13px] leading-[1.4] text-gray-500">
                  Run focused reviews on your current case.
                </p>

                <div className="w-full mt-6">
                  <div className="flex flex-col gap-3">
                    <div className="grid w-full grid-cols-2 gap-x-4 gap-y-3">
                      {compactCaseRows.map((row) => (
                        <div key={row.label} className="min-w-0">
                          <div
                            className="text-[11px] uppercase tracking-[0.12em]"
                            style={brightMangoLabelStyle}
                          >
                            {row.label}
                          </div>
                          <div className="mt-0.5 text-[13px] leading-[1.35] text-gray-300">
                            {row.value || "Not captured yet"}
                          </div>
                        </div>
                      ))}
                    </div>

                    {currentCaseRows.map((row) => (
                      <div key={row.label} className="w-full">
                        <div
                          className="text-[11px] uppercase tracking-[0.12em]"
                          style={brightMangoLabelStyle}
                        >
                          {row.label}
                        </div>
                        <div className="mt-0.5 text-[13px] leading-[1.35] text-gray-300">
                          {row.value || "Not captured yet"}
                        </div>
                      </div>
                    ))}

                    <div className="w-full mt-3">
                      <button
                        onClick={() => {
                          playUITone(720);
                          setMode("A");
                          window.setTimeout(() => {
                            void runCaseReview();
                          }, 50);
                        }}
                        className="w-full cursor-pointer rounded-2xl border py-3.5 text-center transition-opacity hover:opacity-90"
                        style={{
                          borderColor: "rgba(255,176,0,0.86)",
                          background:
                            "linear-gradient(180deg, rgba(255,190,32,0.16) 0%, rgba(255,140,0,0.07) 100%)",
                          boxShadow:
                            "0 0 0 1px rgba(255,176,0,0.15), 0 0 26px rgba(255,176,0,0.18), inset 0 0 22px rgba(255,190,32,0.05)",
                        }}
                      >
                        <div
                          className="text-[15px] font-medium leading-[1.35]"
                          style={{
                            color: "#ffc83d",
                            textShadow: "0 0 12px rgba(255,184,0,0.26)",
                          }}
                        >
                          Get New Case Review
                        </div>
                        <div className="mt-1 text-[12px] leading-[1.35] text-gray-400">
                          Break down the current mechanism and identify the next
                          move.
                        </div>
                      </button>
                    </div>

                    {dashboardData.caseReviewsList?.length > 0 && (
                      <div>
                        <div
                          className="text-[11px] uppercase tracking-[0.12em]"
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
                            const reviewMetadata =
                              review.outcomeLabel ?? review.statusLabel ?? null;

                            return (
                              <button
                                key={review.id}
                                onClick={() => handleOpenCaseReview(review)}
                                className="text-left hover:opacity-80 transition"
                              >
                                <div
                                  className="text-[14px] font-medium leading-[1.35]"
                                  style={{
                                    color: "rgba(255,200,61,0.86)",
                                    textShadow: "0 0 9px rgba(255,184,0,0.12)",
                                  }}
                                >
                                  Case Review — {date}
                                  {reviewMetadata ? ` — ${reviewMetadata}` : ""}
                                </div>

                                <div className="mt-1 text-[13px] leading-[1.4] text-gray-400">
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

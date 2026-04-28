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

type DashboardData = {
  activeCaseTitle: string | null;
  investigationState: string | null;
  signal: string | null;
  hypothesis: string | null;
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
  }[];
};

type ConversationThread = {
  id: number;
  title: string;
  messages: ChatMessage[];
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
  activeCaseTitle: null,
  investigationState: null,
  signal: null,
  hypothesis: null,
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

function segmentRepeatText(text: string): string[] {
  if (!text.trim()) return [];

  const normalized = text.replace(/(\d+)\.\s*/g, "\n$1. ");
  const segments = normalized.split(/(?<=[.!?])\s+/);

  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function normalizeBase64Audio(input: string): string {
  return String(input ?? "")
    .replace(/^data:audio\/[a-zA-Z0-9.+-]+;base64,/, "")
    .replace(/\s+/g, "")
    .trim();
}

export default function Home() {
  const [mode, setMode] = useState<"A" | "C">("A");

  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationIdRef = useRef<number | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
  const [recentConversationThreads, setRecentConversationThreads] = useState<
    ConversationThread[]
  >([]);

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
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const typingInputRef = useRef<HTMLInputElement | null>(null);
  const hasAutoScrolledInitialRef = useRef(false);
  const previousModeRef = useRef<"A" | "C">("A");
  const whoDebugMessageIdRef = useRef<string | null>(null);
  const lastPlayableMessageRef = useRef<{ id: string; text: string } | null>(
    null,
  );
  const lastAutoPlayedMessageIdRef = useRef<string | null>(null);
  const [isRepeatPlaying, setIsRepeatPlaying] = useState(false);
  const [activeRepeatMessageId, setActiveRepeatMessageId] = useState<
    string | null
  >(null);

  const selectedVoice =
    settingsData.voice in VOICE_AVATAR_MAP ? settingsData.voice : "male_coach";
  const selectedVoiceAvatar = VOICE_AVATAR_MAP[selectedVoice];

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
        const resolvedConversationsUrl = new URL(
          conversationsUrl,
          window.location.href,
        ).toString();

        console.log("HOME conversations request:", {
          url: conversationsUrl,
          resolvedUrl: resolvedConversationsUrl,
          credentials: "include",
          protocol: window.location.protocol,
          origin: window.location.origin,
          hostname: window.location.hostname,
        });

        const resp = await fetch(conversationsUrl, {
          credentials: "include",
        });

        const responseText = await resp.text();

        console.log("HOME conversations response:", {
          url: conversationsUrl,
          resolvedUrl: resolvedConversationsUrl,
          status: resp.status,
          statusText: resp.statusText,
          ok: resp.ok,
          contentType: resp.headers.get("content-type"),
          bodyPreview: responseText.slice(0, 500),
        });

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

        console.log("HOME conversations parsed:", {
          shape: Array.isArray(data) ? "array" : typeof data,
          hasConversationsProperty:
            Boolean(data) &&
            typeof data === "object" &&
            "conversations" in data,
          count: conversationRows.length,
          firstConversationId: conversationRows[0]?.id ?? null,
        });

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

        const recentConversations = sortedConversations.slice(0, 3);
        const latest = recentConversations[0] ?? null;

        if (!latest?.id) {
          if (cancelled) return;

          conversationIdRef.current = null;
          setConversationId(null);
          setMessages([]);
          setRecentConversationThreads([]);
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
          setRecentConversationThreads([]);
          setHasExchanged(false);
          localStorage.removeItem("conversationId");
          hasAutoScrolledInitialRef.current = false;
          return;
        }

        const threadResults = await Promise.all(
          recentConversations.map(async (conversation, index) => {
            const id = Number(conversation?.id);

            if (!Number.isFinite(id)) return null;

            const messagesUrl = apiUrl(`/api/messages/${id}`);
            const msgResp = await fetch(messagesUrl, {
              credentials: "include",
            });

            const msgText = await msgResp.text();

            if (!msgResp.ok) {
              throw new Error(
                `Failed to load messages for ${id} (${msgResp.status} ${msgResp.statusText}): ${msgText.slice(
                  0,
                  220,
                )}`,
              );
            }

            const msgData = parseJsonResponseText(
              msgText,
              `Messages ${id}`,
            );
            const normalizedMessages = normalizeLoadedMessages(msgData);
            const title =
              typeof conversation?.title === "string" &&
              conversation.title.trim()
                ? conversation.title.trim()
                : `Conversation ${index + 1}`;

            return {
              id,
              title,
              messages: normalizedMessages,
            } satisfies ConversationThread;
          }),
        );

        const loadedThreads = threadResults.filter(
          (thread): thread is ConversationThread => Boolean(thread),
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

        hasAutoScrolledInitialRef.current = false;
        conversationIdRef.current = latestId;
        setConversationId(latestId);
        setMessages(normalizedMessages);
        setRecentConversationThreads(loadedThreads);
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
        ["adjustment"],
        ["nextMove"],
        ["currentCase", "adjustment"],
        ["currentCase", "nextMove"],
        ["currentCase", "latestAdjustment"],
        ["currentCase", "evidence", "adjustment"],
        ["activeCase", "adjustment"],
        ["activeCase", "nextMove"],
        ["activeCase", "latestAdjustment"],
        ["activeCase", "evidence", "adjustment"],
        ["caseEvidence", "adjustment"],
        ["evidence", "adjustment"],
      ]);

      console.log("INVESTIGATION dashboard payload shape:", {
        topLevelKeys:
          data && typeof data === "object" ? Object.keys(data) : typeof data,
        currentCaseKeys:
          data?.currentCase && typeof data.currentCase === "object"
            ? Object.keys(data.currentCase)
            : null,
        activeCaseKeys:
          data?.activeCase && typeof data.activeCase === "object"
            ? Object.keys(data.activeCase)
            : null,
        caseEvidenceKeys:
          data?.caseEvidence && typeof data.caseEvidence === "object"
            ? Object.keys(data.caseEvidence)
            : null,
        evidenceKeys:
          data?.evidence && typeof data.evidence === "object"
            ? Object.keys(data.evidence)
            : null,
        mapped: {
          signal: Boolean(signal),
          hypothesis: Boolean(hypothesis),
          adjustment: Boolean(adjustment),
        },
      });

      setDashboardData({
        activeCaseTitle: data?.activeCaseTitle ?? null,
        investigationState: data?.investigationState ?? null,
        signal,
        hypothesis,
        adjustment,
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

    const whoAssistantId = nextId();

    setMessages((prev) => [
      ...prev,
      { id: whoAssistantId, role: "assistant", text: "" },
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

    if (!text.trim()) {
      console.warn("Model avatar playback skipped: empty response");
      return;
    }

    const sessionId = ++repeatSessionRef.current;
    const responseText = text.trim();
    const segments = segmentRepeatText(responseText);

    playback.stop();
    stopRequestedRef.current = true;
    setIsSpeaking(false);
    setIsRepeatPlaying(true);
    setActiveRepeatMessageId(messageId);

    console.log("Model avatar TTS start:", {
      messageId,
      voice: selectedVoice,
      textLength: responseText.length,
      segments: segments.length,
    });

    try {
      for (const segment of segments) {
        if (sessionId !== repeatSessionRef.current) return;

        const response = await fetch(apiUrl("/api/tts"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            text: segment,
            voice: selectedVoice,
          }),
        });

        const responseText = await response.text();

        if (!response.ok) {
          console.error("Model avatar TTS request failed:", {
            status: response.status,
            statusText: response.statusText,
            body: responseText.slice(0, 300),
          });
          throw new Error(`TTS failed: ${response.status}`);
        }

        const data = parseJsonResponseText(responseText, "Repeat TTS");
        const audio = normalizeBase64Audio(
          typeof (data as { audio?: unknown })?.audio === "string"
            ? ((data as { audio: string }).audio)
            : "",
        );

        if (!audio) {
          console.error("Model avatar TTS returned no audio:", data);
          throw new Error("TTS returned no audio");
        }

        await new Promise<void>((resolve, reject) => {
          if (sessionId !== repeatSessionRef.current) {
            resolve();
            return;
          }

          if (repeatAudioRef.current) {
            repeatAudioRef.current.onended = null;
            repeatAudioRef.current.onerror = null;
            repeatAudioRef.current.pause();
            repeatAudioRef.current.currentTime = 0;
            repeatAudioRef.current.src = "";
          }

          const player = new Audio(`data:audio/mpeg;base64,${audio}`);
          repeatAudioRef.current = player;
          repeatAudioReleaseRef.current = resolve;

          player.onended = () => {
            if (repeatAudioRef.current === player) {
              repeatAudioRef.current = null;
              repeatAudioReleaseRef.current = null;
            }

            resolve();
          };
          player.onerror = () => {
            console.error("Model avatar playback error:", player.error);
            if (repeatAudioRef.current === player) {
              repeatAudioRef.current = null;
              repeatAudioReleaseRef.current = null;
              setIsRepeatPlaying(false);
              setActiveRepeatMessageId(null);
            }
            reject(player.error ?? new Error("Audio playback failed"));
          };

          player.play().catch((error) => {
            console.error("Model avatar audio.play failed:", error);
            if (repeatAudioRef.current === player) {
              repeatAudioRef.current = null;
              repeatAudioReleaseRef.current = null;
              setIsRepeatPlaying(false);
              setActiveRepeatMessageId(null);
            }
            reject(error);
          });
        });
      }
    } catch (error) {
      console.error("Model avatar playback failed:", error);
    } finally {
      if (sessionId === repeatSessionRef.current) {
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
    console.log("WHO_IS_CORELOOP_CLICKED");
    console.log("WHO_CLICKED");

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
    whoDebugMessageIdRef.current = assistantId;

    setMessages((prev) => {
      const next = [
        ...prev,
        { id: assistantId, role: "assistant", text: "" } as ChatMessage,
      ];

      console.log("WHO_IS_CORELOOP_MESSAGES_AFTER_APPEND", {
        messageId: assistantId,
        count: next.length,
        appended: next[next.length - 1],
      });

      return next;
    });
    setIsProcessing(true);

    try {
      console.log("WHO_IS_CORELOOP_REQUEST_START");

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

      console.log("WHO_IS_CORELOOP_RESPONSE_RECEIVED", {
        textLength: assistantText.length,
      });
      console.log("WHO_RESPONSE_TEXT", assistantText);

      try {
        setMessages((prev) => {
          const next = prev.map((message) =>
            message.id === assistantId
              ? { ...message, text: assistantText }
              : message,
          );

          console.log("WHO_IS_CORELOOP_MESSAGES_AFTER_TEXT_UPDATE", {
            messageId: assistantId,
            count: next.length,
            updated: next.find((message) => message.id === assistantId) ?? null,
            last: next[next.length - 1] ?? null,
          });

          return next;
        });

        setHasExchanged(true);
        hasAutoScrolledInitialRef.current = false;

        console.log("WHO_IS_CORELOOP_MESSAGE_INSERTED", {
          messageId: assistantId,
          textLength: assistantText.length,
        });
      } catch (error) {
        console.error("WHO_APPEND_ERROR", error);
      }

      if (assistantText) {
        window.requestAnimationFrame(() => {
          try {
            scrollMessagesToBottom("smooth");
          } catch (error) {
            console.error("WHO_SCROLL_ERROR", error);
          }

          console.log("WHO_IS_CORELOOP_TTS_START", {
            messageId: assistantId,
            textLength: assistantText.length,
          });
          console.log("WHO_PLAYBACK_START", {
            messageId: assistantId,
            textLength: assistantText.length,
          });

          try {
            void playMessageResponse(assistantId, assistantText).catch(
              (error) => {
                console.error("WHO_TTS_ERROR", error);
              },
            );
          } catch (error) {
            console.error("WHO_TTS_ERROR", error);
          }
        }, 0);
      }
    } catch (error) {
      console.error("WHO_IS_CORELOOP_ERROR", error);
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
    scrollMessagesToBottom,
    stopRepeatPlayback,
    stopSpeech,
  ]);

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

  const currentStateValue = dashboardData.investigationState ?? "No active case";
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
      value: dashboardData.currentTest,
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
      value: dashboardData.lastShift,
    },
    {
      label: "Adjustment",
      value: dashboardData.adjustment,
    },
    {
      label: "Next Move",
      value: dashboardData.adjustment,
    },
  ];

  const displayedConversationThreads = (() => {
    if (messages.length === 0) {
      return recentConversationThreads;
    }

    const activeThreadId = conversationId ?? -1;

    return [
      {
        id: activeThreadId,
        title: "Current Conversation",
        messages,
      },
      ...recentConversationThreads.filter(
        (thread) => thread.id !== activeThreadId,
      ),
    ].slice(0, 3);
  })();

  useEffect(() => {
    const whoMessageId = whoDebugMessageIdRef.current;
    if (!whoMessageId) return;

    const visibleThreads =
      messages.length === 0
        ? recentConversationThreads
        : [
            {
              id: conversationId ?? -1,
              title: "Current Conversation",
              messages,
            },
            ...recentConversationThreads.filter(
              (thread) => thread.id !== (conversationId ?? -1),
            ),
          ].slice(0, 3);

    console.log("WHO_IS_CORELOOP_DISPLAY_THREADS_AFTER_UPDATE", {
      messageId: whoMessageId,
      messagesCount: messages.length,
      messageInMessages:
        messages.find((message) => message.id === whoMessageId) ?? null,
      threadCount: visibleThreads.length,
      visibleThreads: visibleThreads.map((thread) => ({
        id: thread.id,
        messageCount: thread.messages.length,
        containsWhoMessage: thread.messages.some(
          (message) => message.id === whoMessageId,
        ),
        last: thread.messages[thread.messages.length - 1] ?? null,
      })),
    });
  }, [conversationId, messages, recentConversationThreads]);

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

            <div
              ref={messageScrollRef}
              className="absolute left-0 right-0 z-10 overflow-y-auto overflow-x-hidden px-5 sm:px-8"
              style={{
                top: "calc(env(safe-area-inset-top) + 3rem)",
                bottom: "34vh",
                WebkitOverflowScrolling: "touch",
                WebkitMaskImage:
                  "linear-gradient(to bottom, transparent 0%, black 9%, black 84%, rgba(0,0,0,0.72) 92%, transparent 100%)",
                maskImage:
                  "linear-gradient(to bottom, transparent 0%, black 9%, black 84%, rgba(0,0,0,0.72) 92%, transparent 100%)",
              }}
            >
              <div className="mx-auto w-full max-w-[700px] py-8">
                <div className="flex w-full flex-col gap-7">
                  {displayedConversationThreads.length === 0 ? (
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
                    displayedConversationThreads.map((thread, threadIndex) => (
                      <section
                        key={thread.id}
                        className="flex flex-col gap-4"
                        aria-label={`Conversation ${threadIndex + 1}`}
                      >
                        {threadIndex > 0 && (
                          <div
                            className="h-px w-full"
                            style={{
                              background:
                                "linear-gradient(90deg, transparent, rgba(255,200,61,0.16), transparent)",
                            }}
                          />
                        )}

                        <div className="flex flex-col gap-5">
                          {thread.messages.map((message) => {
                            const isUser = message.role === "user";
                            const messagePlaybackId = `${thread.id}-${message.id}`;
                            const isActiveRepeatAvatar =
                              !isUser &&
                              isRepeatPlaying &&
                              activeRepeatMessageId === messagePlaybackId;
                            const isCurrentThread = thread.id === conversationId;
                            const isEditingCurrentMessage =
                              isCurrentThread &&
                              isUser &&
                              editingMessageId === message.id;

                            return (
                              <div
                                key={`${thread.id}-${message.id}`}
                                className={`flex items-start ${
                                  isUser
                                    ? "justify-end gap-2.5"
                                    : "justify-start gap-3"
                                }`}
                              >
                                {!isUser && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      playMessageResponse(
                                        messagePlaybackId,
                                        message.text,
                                      )
                                    }
                                    className="relative mt-1.5 h-9 w-9 shrink-0 rounded-full transition-transform active:scale-95"
                                    aria-label={
                                      isActiveRepeatAvatar
                                        ? "Stop CoreLoop response"
                                        : "Play CoreLoop response"
                                    }
                                  >
                                    <div
                                      className={`absolute inset-[-5px] rounded-full ${
                                        isActiveRepeatAvatar
                                          ? "animate-pulse"
                                          : ""
                                      }`}
                                      style={{
                                        background:
                                          isActiveRepeatAvatar
                                            ? "radial-gradient(circle, rgba(255,213,87,0.36) 0%, rgba(255,176,0,0.18) 42%, transparent 74%)"
                                            : "radial-gradient(circle, rgba(255,200,61,0.14) 0%, rgba(255,176,0,0.075) 42%, transparent 72%)",
                                        boxShadow:
                                          isActiveRepeatAvatar
                                            ? "0 0 22px rgba(255,200,61,0.38)"
                                            : "0 0 18px rgba(255,184,0,0.16)",
                                      }}
                                    />
                                    <div
                                      className="absolute inset-0 overflow-hidden rounded-full border"
                                      style={{
                                        borderColor: "rgba(255,200,61,0.48)",
                                        background: "rgba(10,10,10,0.98)",
                                        boxShadow:
                                          isActiveRepeatAvatar
                                            ? "inset 0 0 10px rgba(255,200,61,0.18), 0 0 0 1px rgba(255,200,61,0.26), 0 0 14px rgba(255,184,0,0.2)"
                                            : "inset 0 0 10px rgba(255,200,61,0.12), 0 0 0 1px rgba(255,176,0,0.065)",
                                      }}
                                    >
                                      <img
                                        src={selectedVoiceAvatar}
                                        alt=""
                                        className="h-full w-full object-cover"
                                      />
                                    </div>
                                  </button>
                                )}

                                <div
                                  className={`relative whitespace-pre-wrap ${
                                    isUser
                                      ? "order-first max-w-[72%] rounded-[8px] rounded-tr-[3px] px-4 py-3 text-right"
                                      : "max-w-[88%] rounded-[10px] rounded-tl-[3px] px-5 py-4"
                                  }`}
                                  style={
                                    isUser
                                      ? {
                                          fontSize: "10.5px",
                                          lineHeight: "1.28",
                                          color: "rgba(255,200,61,0.74)",
                                          background:
                                            "linear-gradient(180deg, rgba(255,176,0,0.06), rgba(255,176,0,0.022))",
                                          border:
                                            "1px solid rgba(255,176,0,0.105)",
                                          boxShadow:
                                            "0 10px 22px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.02)",
                                        }
                                      : {
                                          fontSize: "11.5px",
                                          lineHeight: "1.32",
                                          color: "rgba(229,231,235,0.89)",
                                          background:
                                            "linear-gradient(180deg, rgba(18,18,18,0.98), rgba(8,8,8,0.96))",
                                          border:
                                            "1px solid rgba(255,176,0,0.15)",
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

                                  {isEditingCurrentMessage ? (
                                    <div className="flex flex-col gap-2 text-left">
                                      <input
                                        value={editingText}
                                        onChange={(event) =>
                                          setEditingText(event.target.value)
                                        }
                                        className="w-full rounded-[6px] border bg-black/40 px-2.5 py-2 text-sm text-gray-100 outline-none"
                                        style={{
                                          borderColor: "rgba(255,176,0,0.28)",
                                        }}
                                        autoFocus
                                      />
                                      <div className="flex justify-end gap-3 text-xs">
                                        <button
                                          type="button"
                                          onClick={handleCancelTranscriptEdit}
                                          className="transition-opacity hover:opacity-80"
                                          style={softMangoControlStyle}
                                        >
                                          Cancel
                                        </button>
                                        <button
                                          type="button"
                                          onClick={handleSubmitTranscriptEdit}
                                          className="transition-opacity hover:opacity-90"
                                          style={secondaryMangoStyle}
                                        >
                                          Resend
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    message.text
                                  )}

                                  {isCurrentThread &&
                                    isUser &&
                                    message.source === "voice" &&
                                    editingMessageId !== message.id && (
                                      <div className="mt-2 flex justify-end gap-3 text-[11px] leading-none">
                                        <button
                                          type="button"
                                          disabled={
                                            isProcessing ||
                                            isRecording ||
                                            isSpeaking
                                          }
                                          onClick={() =>
                                            handleEditTranscript(message)
                                          }
                                          className="transition-opacity hover:opacity-90 disabled:opacity-35"
                                          style={softMangoControlStyle}
                                        >
                                          Edit
                                        </button>
                                        <button
                                          type="button"
                                          disabled={isProcessing || isRecording}
                                          onClick={handleRetryTranscript}
                                          className="transition-opacity hover:opacity-90 disabled:opacity-35"
                                          style={softMangoControlStyle}
                                        >
                                          Retry
                                        </button>
                                        <button
                                          type="button"
                                          disabled={
                                            isProcessing ||
                                            isRecording ||
                                            isSpeaking
                                          }
                                          onClick={() =>
                                            resendTranscript(message.text)
                                          }
                                          className="transition-opacity hover:opacity-90 disabled:opacity-35"
                                          style={secondaryMangoStyle}
                                        >
                                          Resend
                                        </button>
                                      </div>
                                    )}
                                </div>

                                {isUser && (
                                  <div className="relative mt-1 h-8 w-8 shrink-0 overflow-hidden rounded-full">
                                    {settingsData.profileImageUrl ? (
                                      <img
                                        src={settingsData.profileImageUrl}
                                        alt="User"
                                        className="h-full w-full rounded-full object-cover"
                                      />
                                    ) : (
                                      <>
                                        <div
                                          className="absolute inset-0 rounded-full border"
                                          style={{
                                            borderColor:
                                              "rgba(255,176,0,0.32)",
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
                                      </>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </section>
                    ))
                  )}
                  <div ref={messageEndRef} />
                </div>
              </div>
            </div>

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

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type Dispatch,
  type SetStateAction,
  type MutableRefObject,
} from "react";
import { motion } from "framer-motion";
import { Volume2 } from "lucide-react";
import { type ChatMessage } from "@/pages/home";
import { sendMessage, streamTTS } from "@/lib/api";
import type { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";

interface ChatViewProps {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onBack?: () => void;
  playback: ReturnType<typeof useAudioPlayback>;
  lastAudioChunksRef: MutableRefObject<string[]>;
  voiceGender: "male" | "female";
  playUITone: (frequency: number, durationMs?: number) => void;
}

let msgCounter = 1000;
function nextChatId() {
  return String(++msgCounter);
}

/* =====================================================
   STREAM MERGE FIX
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
   FORMAT TEXT
   Fixes collapsed numbered lists
===================================================== */

function formatAssistantText(text: string) {
  if (!text) return text;

  return text
    .replace(/(\d+)\./g, "\n$1. ")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

/* =====================================================
   STORAGE HELPERS
===================================================== */

const STORAGE_KEY = "interloop_conversation_id";

function getStoredConversationId(): number | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed = stored ? Number(stored) : null;
    return parsed && Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function setStoredConversationId(id: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(id));
  } catch {}
}

export function ChatView({
  messages,
  setMessages,
  onBack,
  playback,
  lastAudioChunksRef,
  voiceGender,
  playUITone,
}: ChatViewProps) {
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationIdRef = useRef<number | null>(getStoredConversationId());

  /* ================= LOAD HISTORY ON MOUNT ================= */

  useEffect(() => {
    const storedId = conversationIdRef.current;
    if (!storedId) return;

    setIsLoadingHistory(true);

    fetch(`/api/conversations/${storedId}/messages`, {
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) {
          localStorage.removeItem(STORAGE_KEY);
          conversationIdRef.current = null;
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (!data || !Array.isArray(data.messages)) return;

        const loaded: ChatMessage[] = data.messages.map((m: any) => ({
          id: nextChatId(),
          role: m.role as "user" | "assistant",
          text: String(m.content ?? ""),
        }));

        if (loaded.length > 0) {
          setMessages(loaded);
        }
      })
      .catch(() => {})
      .finally(() => {
        setIsLoadingHistory(false);
      });
  }, [setMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /* ================= SEND ================= */

  const handleSend = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;

    await playback.init();
    playback.stop();

    setInputValue("");

    const userMsgId = nextChatId();
    const assistantMsgId = nextChatId();

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", text: trimmed },
      { id: assistantMsgId, role: "assistant", text: "" },
    ]);

    setIsStreaming(true);
    let assistantText = "";

    try {
      await sendMessage(
        conversationIdRef.current,
        trimmed,
        (id: number) => {
          conversationIdRef.current = id;
          setStoredConversationId(id);
        },
        (chunk: string) => {
          assistantText = mergeStream(assistantText, chunk);

          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, text: assistantText } : m,
            ),
          );
        },
      );

      const cache: string[] = [];

      await streamTTS(
        assistantText,
        (chunk: string) => {
          cache.push(chunk);
          playback.pushAudio(chunk);
        },
        { voice: voiceGender },
      );

      playback.signalComplete();
      lastAudioChunksRef.current = cache;
    } finally {
      setIsStreaming(false);
    }
  };

  /* ================= REPLAY ================= */

  const handleReadAloud = useCallback(async () => {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");

    if (!lastAssistant) return;

    await playback.init();
    playback.stop();

    const cache: string[] = [];

    await streamTTS(
      lastAssistant.text,
      (chunk: string) => {
        cache.push(chunk);
        playback.pushAudio(chunk);
      },
      { voice: voiceGender },
    );

    playback.signalComplete();
    lastAudioChunksRef.current = cache;
  }, [messages, playback, voiceGender, lastAudioChunksRef]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen flex flex-col bg-black"
    >
      <div className="flex-1 overflow-y-auto px-6">
        <div className="max-w-xl mx-auto space-y-5">
          {isLoadingHistory && (
            <div className="text-center text-[#444] text-sm pt-8">
              Loading conversation...
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className="
                  max-w-[85%]
                  whitespace-pre-wrap
                  break-words
                  text-lg
                  font-light
                  text-[#e0e0e0]
                  leading-relaxed
                "
              >
                {msg.role === "assistant"
                  ? formatAssistantText(msg.text)
                  : msg.text}
              </div>
            </div>
          ))}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-[#1a1a1a] p-4">
        <div className="max-w-xl mx-auto flex items-end gap-3">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Type here"
            className="
              flex-1
              bg-transparent
              resize-none
              outline-none
              text-[#e0e0e0]
            "
            rows={1}
          />

          <button
            onClick={() => {
              playUITone(720);
              handleReadAloud();
            }}
          >
            <Volume2 />
          </button>
        </div>

        {onBack && (
          <div className="text-center pt-3">
            <button
              onClick={() => {
                playUITone(720);
                onBack();
              }}
              className="text-sm text-[#666] hover:text-[#888]"
            >
              Prefer speaking?
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

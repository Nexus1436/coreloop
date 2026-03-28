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
  // Correct interface: no arguments
  playUITone: () => void;
  // Home is the single source of truth for conversationId
  conversationId: number | null;
  onConversationId: (id: number) => void;
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
===================================================== */

function formatAssistantText(text: string) {
  if (!text) return text;

  return text
    .replace(/(\d+)\./g, "\n$1. ")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

export function ChatView({
  messages,
  setMessages,
  onBack,
  playback,
  lastAudioChunksRef,
  voiceGender,
  playUITone,
  conversationId,
  onConversationId,
}: ChatViewProps) {
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Mirror prop into ref so handleSend closure always sees current value
  // without re-creating the function on every conversationId change
  const conversationIdRef = useRef<number | null>(conversationId);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

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
          onConversationId(id);
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
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div className="max-w-[85%] whitespace-pre-wrap break-words text-lg font-light text-[#e0e0e0] leading-relaxed">
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
            className="flex-1 bg-transparent resize-none outline-none text-[#e0e0e0]"
            rows={1}
          />

          <button
            onClick={() => {
              playUITone();
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
                playUITone();
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

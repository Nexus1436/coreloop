// ChatView.tsx
import {
  useState,
  useRef,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import { motion } from "framer-motion";
import { type ChatMessage } from "@/pages/home";
import { sendMessage } from "@/lib/api";

interface ChatViewProps {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onBack?: () => void;
  playUITone: (frequency?: number, durationMs?: number) => void;
  onConversationIdChange: (conversationId: number) => void;
  onPlaybackControl: () => void;
  playbackLabel: string;
  onSpeakText: (text: string) => Promise<void>;
}

let msgCounter = 1000;
function nextChatId() {
  return String(++msgCounter);
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
  playUITone,
  onConversationIdChange,
  onPlaybackControl,
  playbackLabel,
  onSpeakText,
}: ChatViewProps) {
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationIdRef = useRef<number | null>(null);

  useEffect(() => {
    const storedId = localStorage.getItem("conversationId");
    const parsed = storedId ? Number(storedId) : NaN;

    if (Number.isFinite(parsed)) {
      conversationIdRef.current = parsed;
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;

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
          onConversationIdChange(id);
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

      if (assistantText.trim()) {
        await onSpeakText(assistantText);
      }
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen flex flex-col bg-black"
    >
      <div className="flex-1 overflow-y-auto px-6">
        <div className="max-w-xl mx-auto space-y-5 py-5">
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

          <button onClick={onPlaybackControl}>{playbackLabel}</button>
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

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
import { Mic, Square, Volume2 } from "lucide-react";
import { type ChatMessage } from "@/pages/home";
import { sendMessage, transcribeAudio, streamTTS } from "@/lib/api";
import type { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";

interface ChatViewProps {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  onBack?: () => void;
  playback: ReturnType<typeof useAudioPlayback>;
  lastAudioChunksRef: MutableRefObject<string[]>;
  voiceGender: "male" | "female"; // 🔥 from Home
}

let msgCounter = 1000;
function nextChatId() {
  return String(++msgCounter);
}

export function ChatView({
  messages,
  setMessages,
  onBack,
  playback,
  lastAudioChunksRef,
  voiceGender,
}: ChatViewProps) {
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      await sendMessage(0, trimmed, (chunk) => {
        assistantText += chunk;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, text: assistantText } : m,
          ),
        );
      });

      const cache: string[] = [];
      await streamTTS(
        assistantText,
        (chunk: string) => {
          cache.push(chunk);
          playback.pushAudio(chunk);
        },
        { voice: voiceGender }, // 🔥 USE SHARED VOICE
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
  }, [messages, voiceGender]);

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
              <p className="max-w-[85%] whitespace-pre-wrap text-lg font-light text-[#e0e0e0]">
                {msg.text}
              </p>
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

          <button onClick={handleReadAloud}>
            <Volume2 />
          </button>
        </div>

        {onBack && (
          <div className="text-center pt-3">
            <button
              onClick={onBack}
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

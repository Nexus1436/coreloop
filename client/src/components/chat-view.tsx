import { useState, useRef, useEffect, useCallback, type Dispatch, type SetStateAction } from "react";
import { motion } from "framer-motion";
import { Mic, Volume2 } from "lucide-react";
import { type ChatMessage } from "@/pages/home";
import { sendMessage, streamTTS } from "@/lib/api";
import { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";

interface ChatViewProps {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  conversationId: number | null;
  ensureConversation: () => Promise<number>;
  onBack?: () => void;
}

let msgCounter = 1000;
function nextChatId() {
  return String(++msgCounter);
}

export function ChatView({ messages, setMessages, conversationId, ensureConversation, onBack }: ChatViewProps) {
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const playback = useAudioPlayback();

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSend = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;

    setInputValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const userMsgId = nextChatId();
    setMessages((prev) => [...prev, { id: userMsgId, role: "user", text: trimmed }]);

    setIsStreaming(true);
    const assistantMsgId = nextChatId();
    let assistantText = "";

    try {
      const convId = await ensureConversation();

      await sendMessage(convId, trimmed, (chunk) => {
        assistantText += chunk;
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === assistantMsgId);
          if (existing) {
            return prev.map((m) => m.id === assistantMsgId ? { ...m, text: assistantText } : m);
          }
          return [...prev, { id: assistantMsgId, role: "assistant", text: assistantText }];
        });
      });
    } catch (err) {
      console.error("Send error:", err);
    } finally {
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };

  const handleReadAloud = useCallback(async () => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    await playback.init();
    playback.clear();
    await streamTTS(lastAssistant.text, (audioChunk) => {
      playback.pushAudio(audioChunk);
    });
    playback.signalComplete();
  }, [messages, playback]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="min-h-screen w-full flex flex-col bg-black"
      data-testid="chat-view"
    >
      <div className="flex items-center justify-center pt-10 pb-4 px-6">
        <img
          src="/logo.png"
          alt="Interloop"
          className="h-10 md:h-12 object-contain"
          style={{ opacity: 0.75, filter: "brightness(0.6)" }}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-5 md:px-8 pb-4" data-testid="message-thread">
        <div className="max-w-xl mx-auto space-y-5 pt-4">
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              data-testid={`message-${msg.role}-${msg.id}`}
            >
              <p
                className={`text-base md:text-lg font-light leading-relaxed max-w-[85%] whitespace-pre-wrap ${
                  msg.role === "assistant"
                    ? "text-[#e0e0e0]"
                    : "text-[#999999]"
                }`}
              >
                {msg.text}
              </p>
            </motion.div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-[#1a1a1a] px-4 md:px-6 py-4">
        <div className="max-w-xl mx-auto flex items-end gap-3">
          <button
            className="flex-shrink-0 p-2.5 rounded-full transition-colors duration-200"
            style={{ color: "#555555" }}
            disabled
            aria-label="Microphone (coming soon)"
            data-testid="button-mic"
          >
            <Mic size={20} />
          </button>

          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder="Type here"
              rows={1}
              className="w-full bg-transparent text-[#e0e0e0] text-base font-light leading-relaxed resize-none outline-none placeholder-[#3a3a3a] py-2"
              style={{ caretColor: "#858585", maxHeight: "120px" }}
              data-testid="input-message"
            />
          </div>

          <button
            className="flex-shrink-0 p-2.5 rounded-full transition-colors duration-200 hover:text-[#858585]"
            style={{ color: "#555555" }}
            onClick={handleReadAloud}
            disabled={!messages.some((m) => m.role === "assistant")}
            aria-label="Read aloud"
            data-testid="button-speaker"
          >
            <Volume2 size={20} />
          </button>
        </div>

        {onBack && (
          <div className="max-w-xl mx-auto flex justify-center pt-3 pb-[env(safe-area-inset-bottom,4px)]">
            <button
              onClick={onBack}
              className="text-sm font-medium text-[#555555] hover:text-[#858585] transition-colors duration-300"
              data-testid="link-prefer-speaking"
            >
              Prefer speaking?
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

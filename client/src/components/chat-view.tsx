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
import { transcribeAudio, streamTTS } from "@/lib/api";
import type { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";

interface ChatViewProps {
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  conversationId: number | null;
  ensureConversation: () => Promise<number>;
  onBack?: () => void;
  playback: ReturnType<typeof useAudioPlayback>;
  lastAudioChunksRef: MutableRefObject<string[]>;
}

let msgCounter = 1000;
function nextChatId() {
  return String(++msgCounter);
}

export function ChatView({
  messages,
  setMessages,
  conversationId,
  ensureConversation,
  onBack,
  playback,
  lastAudioChunksRef,
}: ChatViewProps) {
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [isMicProcessing, setIsMicProcessing] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micChunksRef = useRef<Blob[]>([]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(scrollToBottom, [messages]);
  useEffect(() => textareaRef.current?.focus(), []);

  /* ────────────────────────────────────────────────
     🔴 CORE FIX: DIRECT STREAM FROM /api/chat
     ──────────────────────────────────────────────── */
  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || isStreaming) return;

    setInputValue("");
    setIsStreaming(true);

    const userId = nextChatId();
    const assistantId = nextChatId();

    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text },
      { id: assistantId, role: "assistant", text: "" },
    ]);

    try {
      await ensureConversation();

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: text }],
        }),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        assistantText += decoder.decode(value, { stream: true });

        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, text: assistantText } : m,
          ),
        );
      }
    } catch (err) {
      console.error("Streaming error:", err);
    } finally {
      setIsStreaming(false);
      lastAudioChunksRef.current = [];
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleMicTap = async () => {
    if (isMicProcessing) return;

    if (isMicRecording) {
      const recorder = micRecorderRef.current;
      if (!recorder) return;

      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(micChunksRef.current, { type: "audio/webm" }));
        };
        recorder.stop();
      });

      setIsMicRecording(false);
      setIsMicProcessing(true);

      try {
        const transcript = await transcribeAudio(blob);
        if (transcript) setInputValue(transcript);
      } finally {
        setIsMicProcessing(false);
      }
    } else {
      setIsMicRecording(true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      micRecorderRef.current = recorder;
      micChunksRef.current = [];
      recorder.ondataavailable = (e) => micChunksRef.current.push(e.data);
      recorder.start();
    }
  };

  const handleReadAloud = useCallback(async () => {
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    if (!last) return;

    await playback.init();
    playback.clear();

    const cache = lastAudioChunksRef.current;
    if (cache.length) {
      cache.forEach(playback.pushAudio);
      playback.signalComplete();
      return;
    }

    const newCache: string[] = [];
    await streamTTS(last.text, (chunk) => {
      newCache.push(chunk);
      playback.pushAudio(chunk);
    });
    playback.signalComplete();
    lastAudioChunksRef.current = newCache;
  }, [messages]);

  return (
    <motion.div className="min-h-screen flex flex-col bg-black">
      <div className="flex-1 overflow-y-auto px-6">
        {messages.map((m) => (
          <p
            key={m.id}
            className={m.role === "assistant" ? "text-white" : "text-gray-400"}
          >
            {m.text}
          </p>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <textarea
        ref={textareaRef}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type here"
      />

      <button onClick={handleSend} disabled={isStreaming}>
        Send
      </button>
    </motion.div>
  );
}

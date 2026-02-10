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

  /* ===============================
     SEND TEXT (SSE STREAMING)
     =============================== */
  const handleSend = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;

    setInputValue("");
    textareaRef.current!.style.height = "auto";

    const userMsgId = nextChatId();
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", text: trimmed },
    ]);

    const assistantMsgId = nextChatId();
    let assistantText = "";

    setIsStreaming(true);

    try {
      await sendMessage(
        0, // unused — kept for API compatibility
        trimmed,
        (chunk) => {
          assistantText += chunk;
          setMessages((prev) => {
            const exists = prev.find((m) => m.id === assistantMsgId);
            if (exists) {
              return prev.map((m) =>
                m.id === assistantMsgId ? { ...m, text: assistantText } : m,
              );
            }
            return [
              ...prev,
              { id: assistantMsgId, role: "assistant", text: assistantText },
            ];
          });
        },
      );
    } catch (err) {
      console.error("Streaming error:", err);
    } finally {
      setIsStreaming(false);
      lastAudioChunksRef.current = [];
    }
  };

  /* ===============================
     INPUT HANDLERS
     =============================== */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
  };

  /* ===============================
     MICROPHONE
     =============================== */
  const handleMicTap = async () => {
    if (isMicProcessing) return;

    if (isMicRecording) {
      const recorder = micRecorderRef.current;
      if (!recorder) return;

      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          const audio = new Blob(micChunksRef.current, {
            type: "audio/webm",
          });
          recorder.stream.getTracks().forEach((t) => t.stop());
          resolve(audio);
        };
        recorder.stop();
      });

      setIsMicRecording(false);
      setIsMicProcessing(true);

      try {
        const transcript = await transcribeAudio(blob);
        if (transcript?.trim()) {
          setInputValue((prev) =>
            prev.trim() ? `${prev} ${transcript}` : transcript,
          );
          textareaRef.current?.focus();
        }
      } catch (err) {
        console.error("Transcription error:", err);
      } finally {
        setIsMicProcessing(false);
      }
    } else {
      setIsMicRecording(true);
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          const recorder = new MediaRecorder(stream, {
            mimeType: "audio/webm;codecs=opus",
          });
          micRecorderRef.current = recorder;
          micChunksRef.current = [];

          recorder.ondataavailable = (e) =>
            e.data.size && micChunksRef.current.push(e.data);

          recorder.start(100);
        })
        .catch(() => setIsMicRecording(false));
    }
  };

  /* ===============================
     READ ALOUD
     =============================== */
  const handleReadAloud = useCallback(async () => {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    await playback.init();
    playback.clear();

    if (lastAudioChunksRef.current.length) {
      lastAudioChunksRef.current.forEach(playback.pushAudio);
      playback.signalComplete();
      return;
    }

    const cache: string[] = [];
    await streamTTS(lastAssistant.text, (chunk) => {
      cache.push(chunk);
      playback.pushAudio(chunk);
    });

    playback.signalComplete();
    lastAudioChunksRef.current = cache;
  }, [messages]);

  /* ===============================
     RENDER
     =============================== */
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="min-h-screen flex flex-col bg-black"
    >
      <div className="flex justify-center pt-10 pb-4">
        <img src="/logo.png" alt="Interloop" className="h-10 opacity-70" />
      </div>

      <div className="flex-1 overflow-y-auto px-6">
        <div className="max-w-xl mx-auto space-y-5">
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <p
                className={`max-w-[85%] whitespace-pre-wrap text-lg font-light ${
                  msg.role === "assistant" ? "text-[#e0e0e0]" : "text-[#999]"
                }`}
              >
                {msg.text}
              </p>
            </motion.div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-[#1a1a1a] p-4">
        <div className="max-w-xl mx-auto flex items-end gap-3">
          <button onClick={handleMicTap} disabled={isStreaming}>
            {isMicRecording ? <Square /> : <Mic />}
          </button>

          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
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

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CentralForm } from "@/components/central-form";
import { ChatView } from "@/components/chat-view";
import { createConversation, sendVoiceMessage, streamTTS } from "@/lib/api";
import { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

let messageCounter = 0;
function nextId() {
  return String(++messageCounter);
}

export default function Home() {
  const [mode, setMode] = useState<"A" | "B">("A");
  const [hasPressed, setHasPressed] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [replayText, setReplayText] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const playback = useAudioPlayback();

  const lastResponse = useMemo(() => {
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    return assistantMessages.length > 0
      ? assistantMessages[assistantMessages.length - 1].text
      : null;
  }, [messages]);

  const ensureConversation = useCallback(async () => {
    if (conversationId) return conversationId;
    const conv = await createConversation();
    setConversationId(conv.id);
    return conv.id;
  }, [conversationId]);

  const handleScreenTap = async () => {
    if (!hasPressed) {
      setHasPressed(true);
      setIsRecording(true);

      const micPromise = navigator.mediaDevices.getUserMedia({ audio: true });

      micPromise.then((stream) => {
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
        mediaRecorderRef.current = recorder;
        chunksRef.current = [];

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };

        recorder.start(100);
      }).catch((err) => {
        console.error("Microphone access denied:", err);
        setIsRecording(false);
        setHasPressed(false);
      });

      return;
    }

    if (isProcessing) return;

    if (isRecording) {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state !== "recording") return;

      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          const b = new Blob(chunksRef.current, { type: "audio/webm" });
          recorder.stream.getTracks().forEach((t) => t.stop());
          resolve(b);
        };
        recorder.stop();
      });

      setIsRecording(false);
      setIsProcessing(true);

      try {
        const convId = await ensureConversation();

        let assistantText = "";
        const assistantMsgId = nextId();

        await sendVoiceMessage(convId, blob, {
          onUserTranscript: (text) => {
            setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
          },
          onTranscript: (chunk) => {
            assistantText += chunk;
            setMessages((prev) => {
              const existing = prev.find((m) => m.id === assistantMsgId);
              if (existing) {
                return prev.map((m) => m.id === assistantMsgId ? { ...m, text: assistantText } : m);
              }
              return [...prev, { id: assistantMsgId, role: "assistant", text: assistantText }];
            });
          },
          onDone: async (transcript) => {
            if (!transcript || !transcript.trim()) return;
            await playback.init();
            playback.clear();
            await streamTTS(transcript, (audioChunk) => {
              playback.pushAudio(audioChunk);
            });
            playback.signalComplete();
          },
        });
      } catch (err) {
        console.error("Voice message error:", err);
      } finally {
        setIsProcessing(false);
      }
    } else {
      setIsRecording(true);

      const micPromise = navigator.mediaDevices.getUserMedia({ audio: true });

      micPromise.then((stream) => {
        const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
        mediaRecorderRef.current = recorder;
        chunksRef.current = [];

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };

        recorder.start(100);
      }).catch((err) => {
        console.error("Microphone access denied:", err);
        setIsRecording(false);
      });
    }
  };

  const handleSwitchToB = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMode("B");
  };

  const handleSwitchToA = () => {
    setMode("A");
    setHasPressed(false);
  };

  const handleRepeatResponse = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!lastResponse) return;

    setReplayText(lastResponse);

    await playback.init();
    playback.clear();
    await streamTTS(lastResponse, (audioChunk) => {
      playback.pushAudio(audioChunk);
    });
    playback.signalComplete();

    setTimeout(() => setReplayText(null), 4000);
  }, [lastResponse, playback]);

  if (mode === "B") {
    return (
      <ChatView
        messages={messages}
        setMessages={setMessages}
        conversationId={conversationId}
        ensureConversation={ensureConversation}
        onBack={handleSwitchToA}
      />
    );
  }

  return (
    <div
      className="min-h-screen w-full flex flex-col items-center justify-center overflow-hidden cursor-pointer select-none bg-black relative"
      onClick={handleScreenTap}
    >
      <div className="flex-1 flex flex-col items-center justify-center relative w-full">
        <CentralForm isActive={hasPressed} isDimmed={false} />

        <AnimatePresence>
          {!hasPressed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.65 }}
              exit={{ opacity: 0, transition: { duration: 0.6, ease: "easeOut" } }}
              transition={{ duration: 1.2 }}
              className="absolute pointer-events-none"
            >
              <p className="text-sm md:text-base font-light text-[#b0b0b0] tracking-wide text-center">
                Press here
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {isRecording && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.6 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="absolute pointer-events-none mt-48"
            >
              <p className="text-xs font-light text-[#858585] tracking-widest uppercase">
                listening
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {replayText && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.8 }}
              exit={{ opacity: 0, transition: { duration: 1, ease: "easeOut" } }}
              transition={{ duration: 0.5 }}
              className="absolute pointer-events-none mt-40"
            >
              <p className="text-base md:text-lg font-light text-[#e0e0e0] tracking-wide text-center max-w-sm px-6 leading-relaxed">
                {replayText}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="absolute bottom-12 md:bottom-16 left-0 right-0 flex justify-between items-baseline px-8 md:px-12 pointer-events-none">
        <div
          className="pointer-events-auto"
          onClick={handleSwitchToB}
        >
          <p
            className="text-lg font-medium text-[#858585] leading-relaxed hover:text-[#a3a3a3] transition-colors duration-300"
            style={{ opacity: 0.85 }}
            data-testid="link-prefer-typing"
          >
            Prefer typing?
          </p>
        </div>

        {lastResponse ? (
          <div
            className="pointer-events-auto"
            onClick={handleRepeatResponse}
          >
            <p
              className="text-lg font-medium text-[#909090] leading-relaxed transition-colors duration-300"
              style={{ opacity: 0.68 }}
              data-testid="button-repeat-response"
            >
              Repeat response
            </p>
          </div>
        ) : (
          <div />
        )}
      </div>
    </div>
  );
}

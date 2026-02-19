import { useState, useMemo, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CentralForm } from "@/components/central-form";
import { ChatView } from "@/components/chat-view";
import { sendMessage, transcribeAudio, streamTTS } from "@/lib/api";
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
  /* ================= MODE ================= */
  const [mode, setMode] = useState<"A" | "B">("A");

  /* ================= CHAT STATE ================= */
  const [hasPressed, setHasPressed] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  /* ================= VOICE ================= */
  // MALE DEFAULT
  const [voiceGender, setVoiceGender] = useState<"male" | "female">("male");

  /* IMPORTANT:
     These strings MUST match what your server expects.
     Server resolves:
     - "male" -> ELEVEN_VOICE_ID_MALE
     - "female" -> ELEVEN_VOICE_ID_FEMALE
  */
  const resolvedVoice = voiceGender;

  /* ================= AUDIO ENGINE ================= */
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const lastAudioChunksRef = useRef<string[]>([]);
  const playback = useAudioPlayback();

  const lastResponse = useMemo(() => {
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    return assistantMessages.length
      ? assistantMessages[assistantMessages.length - 1].text
      : null;
  }, [messages]);

  /* ================= RECORDER ================= */

  const startRecorderOnStream = (stream: MediaStream) => {
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.start();
  };

  const stopAndGetBlob = async (): Promise<Blob> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return new Blob();

    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    const blob = new Blob(chunksRef.current, {
      type: "audio/webm",
    });

    recorder.stream.getTracks().forEach((t) => t.stop());

    mediaRecorderRef.current = null;
    chunksRef.current = [];

    return blob;
  };

  /* ================= VOICE FLOW ================= */

  const runSTTThenChat = async (audioBlob: Blob) => {
    const transcript = await transcribeAudio(audioBlob);
    const userText = (transcript || "").trim();
    if (!userText) return;

    const userMsgId = nextId();
    const assistantMsgId = nextId();

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", text: userText },
      { id: assistantMsgId, role: "assistant", text: "" },
    ]);

    let assistantText = "";

    await sendMessage(0, userText, (chunk) => {
      assistantText += chunk;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId ? { ...m, text: assistantText } : m,
        ),
      );
    });

    if (mode === "A") {
      try {
        await playback.init();
        playback.stop();

        const cache: string[] = [];

        await streamTTS(
          assistantText,
          (audioChunk: string) => {
            cache.push(audioChunk);
            playback.pushAudio(audioChunk);
          },
          {
            voice: resolvedVoice,
            speed: 0.97,
          },
        );

        playback.signalComplete();
        lastAudioChunksRef.current = cache;
      } catch (err) {
        console.error("TTS error:", err);
      }
    }
  };

  /* ================= TAP LOGIC ================= */

  const handleScreenTap = async () => {
    if (!hasPressed) {
      setHasPressed(true);
      setIsRecording(true);

      await playback.init();
      playback.stop();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        micStreamRef.current = stream;
        startRecorderOnStream(stream);
      } catch (err) {
        console.error("Microphone access denied:", err);
        setIsRecording(false);
        setHasPressed(false);
      }

      return;
    }

    if (isProcessing) return;

    if (isRecording) {
      setIsRecording(false);
      setIsProcessing(true);

      try {
        const blob = await stopAndGetBlob();
        if (!blob || blob.size === 0) return;
        await runSTTThenChat(blob);
      } catch (err) {
        console.error("Voice flow error:", err);
      } finally {
        setIsProcessing(false);
      }

      return;
    }

    setIsRecording(true);

    await playback.init();
    playback.stop();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      micStreamRef.current = stream;
      startRecorderOnStream(stream);
    } catch (err) {
      console.error("Microphone access denied:", err);
      setIsRecording(false);
    }
  };

  /* ================= MODE SWITCH ================= */

  const handleSwitchToB = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMode("B");
  };

  const handleSwitchToA = () => {
    setMode("A");
    setHasPressed(false);
  };

  /* ================= REPLAY ================= */

  const handleRepeatResponse = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!lastResponse) return;

      await playback.init();
      playback.stop();

      const cache: string[] = [];

      await streamTTS(
        lastResponse,
        (audioChunk: string) => {
          cache.push(audioChunk);
          playback.pushAudio(audioChunk);
        },
        {
          voice: resolvedVoice,
          speed: 0.97,
        },
      );

      playback.signalComplete();
      lastAudioChunksRef.current = cache;
    },
    [lastResponse, resolvedVoice],
  );

  /* ================= MODE B ================= */

  if (mode === "B") {
    return (
      <ChatView
        messages={messages}
        setMessages={setMessages}
        onBack={handleSwitchToA}
        playback={playback}
        lastAudioChunksRef={lastAudioChunksRef}
        voiceGender={voiceGender}
      />
    );
  }

  /* ================= MODE A UI ================= */

  return (
    <div
      className="min-h-screen w-full flex flex-col items-center justify-center bg-black relative"
      onClick={handleScreenTap}
    >
      <div className="flex-1 flex flex-col items-center justify-center relative w-full">
        <CentralForm isActive={hasPressed} isDimmed={false} />

        <div className="absolute pointer-events-none">
          {isRecording ? (
            <p className="text-sm text-[#858585] uppercase text-center">
              Listening…
            </p>
          ) : !isProcessing ? (
            <p className="text-sm text-[#b0b0b0] text-center">Press here</p>
          ) : null}
        </div>
      </div>

      <div className="absolute bottom-12 left-0 right-0 flex justify-between items-center px-8">
        <div onClick={handleSwitchToB}>
          <p className="text-lg text-[#858585] hover:text-[#a3a3a3]">
            Prefer typing?
          </p>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            setVoiceGender((prev) => (prev === "male" ? "female" : "male"));
          }}
          className="text-sm text-[#909090] hover:text-white"
        >
          Voice: {voiceGender === "male" ? "Male" : "Female"}
        </button>

        {lastResponse ? (
          <div onClick={handleRepeatResponse}>
            <p className="text-lg text-[#909090] hover:text-white">
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

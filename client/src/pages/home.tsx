import { useState, useRef, useMemo, useEffect, useCallback } from "react";

import { CentralForm } from "@/components/central-form";
import { ChatView } from "@/components/chat-view";

import { transcribeAudio, streamTTS } from "@/lib/api";

import { useAudioPlayback } from "../../replit_integrations/audio/useAudioPlayback";
import { useVoiceRecorder } from "../../replit_integrations/audio/useVoiceRecorder";

export interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
}

let messageCounter = 0;
function nextId() {
  return String(++messageCounter);
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
   STREAM CHAT
===================================================== */

async function sendChat(
  conversationId: number | null,
  userText: string,
  onConversationId: (id: number) => void,
  onChunk: (chunk: string) => void,
) {
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      conversationId: conversationId ?? undefined,
      messages: [{ role: "user", content: userText }],
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

/* =====================================================
   ONBOARDING MESSAGE
   Shown once to brand-new users with no conversations
===================================================== */

const ONBOARDING_TEXT =
  "Welcome to Interloop. Hi, I'm Interloop. I'm going to be your movement companion over time, helping you investigate how your body moves and how small adjustments affect it. Think of this as an ongoing process. We'll notice movement signals together, try small experiments, and see what changes. The more you use me — and the more clearly you tell me what you notice and what happens after you try something — the better I can help you. I work best when you describe things in your own words. You don't need to be concise. You can ramble a little if you want and talk through what you're feeling, what movements feel strange, and what you've already tried. If you ever feel stuck or unsure what to say, just ask me. I'll guide you. For example, you might say something like: When I go downstairs my knee feels like it catches near the bottom step. Or, My shoulder feels fine until I raise my arm above my head, then it feels tight in the front. So let's start with this: What movement or sensation have you noticed recently that feels off, different, or uncomfortable? Just talk it through. I'm listening.";

/* =====================================================
   COMPONENT
===================================================== */

export default function Home() {
  const [mode, setMode] = useState<"A" | "B">("A");

  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationIdRef = useRef<number | null>(null);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const [voiceGender, setVoiceGender] = useState<"male" | "female">("female");
  const voiceGenderRef = useRef<"male" | "female">(voiceGender);

  useEffect(() => {
    voiceGenderRef.current = voiceGender;
  }, [voiceGender]);

  const playback = useAudioPlayback();
  const recorder = useVoiceRecorder();

  const stopRequestedRef = useRef(false);
  const lastAudioChunksRef = useRef<string[]>([]);

  const lastResponse = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].text;
    }
    return null;
  }, [messages]);

  /* =====================================================
     LOAD LATEST CONVERSATION (+ ONBOARDING FOR NEW USERS)
  ===================================================== */

  useEffect(() => {
    async function loadLatestConversation() {
      try {
        const resp = await fetch("/api/conversations", {
          credentials: "include",
        });

        if (!resp.ok) return;

        const data = await resp.json();
        const convs = data?.conversations;

        // NEW USER — no conversations yet: show onboarding message
        if (!Array.isArray(convs) || convs.length === 0) {
          setMessages([
            {
              id: nextId(),
              role: "assistant",
              text: ONBOARDING_TEXT,
            },
          ]);

          try {
            await playback.init();
            stopRequestedRef.current = false;
            setIsSpeaking(true);
            await streamTTS(
              ONBOARDING_TEXT,
              (audioChunk: string) => {
                if (!stopRequestedRef.current) {
                  playback.pushAudio(audioChunk);
                }
              },
              { voice: voiceGenderRef.current },
            );
            if (!stopRequestedRef.current) {
              playback.signalComplete();
            }
          } catch (err) {
            console.error("Onboarding TTS failed:", err);
            setIsSpeaking(false);
          }

          return;
        }

        // RETURNING USER — load their latest conversation
        const latestId = Number(convs[0].id);
        if (!Number.isFinite(latestId)) return;

        const msgResp = await fetch(`/api/conversations/${latestId}/messages`, {
          credentials: "include",
        });

        if (!msgResp.ok) return;

        const msgData = await msgResp.json();
        const rows = msgData?.messages;

        if (!Array.isArray(rows)) return;

        conversationIdRef.current = latestId;
        setConversationId(latestId);

        setMessages(
          rows.map((m: any) => ({
            id: String(m.id),
            role: m.role,
            text: m.content,
          })),
        );
      } catch (err) {
        console.error("Load conversation failed:", err);
      }
    }

    loadLatestConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* =====================================================
     SPEAKING STATE SYNC
  ===================================================== */

  useEffect(() => {
    if (playback.state === "ended" || playback.state === "idle") {
      setIsSpeaking(false);
    }
  }, [playback.state]);

  /* =====================================================
     CASE REVIEW
  ===================================================== */

  const runCaseReview = async () => {
    if (isProcessing || isRecording) return;

    setIsProcessing(true);

    const userId = nextId();
    const assistantId = nextId();

    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text: "Case review requested." },
      { id: assistantId, role: "assistant", text: "" },
    ]);

    let assistantText = "";

    try {
      stopRequestedRef.current = false;
      playback.stop();
      // Clear isProcessing so label shows "Press here to stop" not "Reflecting..."
      setIsProcessing(false);
      setIsSpeaking(true);

      await streamTTS(
        "I've been reflecting on your case. Give me a minute and I'll let you know what I found.",
        (chunk) => {
          if (!stopRequestedRef.current) playback.pushAudio(chunk);
        },
        { voice: voiceGenderRef.current },
      );

      if (!stopRequestedRef.current) playback.signalComplete();
      if (stopRequestedRef.current) return;

      // Re-enter processing state for the AI call (label: "Reflecting...")
      setIsSpeaking(false);
      setIsProcessing(true);

      await sendChat(
        conversationIdRef.current,
        "Case review",
        (id) => {
          conversationIdRef.current = id;
          setConversationId(id);
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

      if (stopRequestedRef.current) return;

      // Back to speaking for the full response
      setIsProcessing(false);
      playback.stop();
      setIsSpeaking(true);

      await streamTTS(
        assistantText,
        (audioChunk) => {
          if (!stopRequestedRef.current) playback.pushAudio(audioChunk);
        },
        { voice: voiceGenderRef.current },
      );

      if (!stopRequestedRef.current) playback.signalComplete();
    } catch (err) {
      console.error("Case review failed:", err);
    } finally {
      setIsProcessing(false);
      setIsSpeaking(false);
    }
  };

  /* =====================================================
     REPEAT RESPONSE
  ===================================================== */

  const repeatLast = async () => {
    if (!lastResponse) return;

    playback.stop();
    stopRequestedRef.current = false;
    setIsSpeaking(true);

    await streamTTS(lastResponse, (chunk) => playback.pushAudio(chunk), {
      voice: voiceGenderRef.current,
    });

    playback.signalComplete();
  };

  /* =====================================================
     TAP FLOW
  ===================================================== */

  const handleTap = useCallback(async () => {
    // If speaking — stop
    if (isSpeaking) {
      stopRequestedRef.current = true;
      playback.stop();
      setIsSpeaking(false);
      setIsProcessing(false);
      return;
    }

    if (isProcessing) return;

    // START RECORDING
    if (!isRecording) {
      try {
        stopRequestedRef.current = true;
        playback.stop();
        setIsSpeaking(false);
        await recorder.startRecording();
        setIsRecording(true);
      } catch (err) {
        console.error("Mic failed:", err);
      }
      return;
    }

    // STOP RECORDING → process
    setIsRecording(false);
    setIsProcessing(true);

    try {
      const blob = await recorder.stopRecording();

      // ── 2s natural delay then "I hear you." ──
      const hearYouId = nextId();
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      setMessages((prev) => [
        ...prev,
        { id: hearYouId, role: "assistant", text: "I hear you." },
      ]);

      // Speak "I hear you." non-blocking
      playback.init().then(() => {
        stopRequestedRef.current = false;
        setIsSpeaking(true);
        streamTTS(
          "I hear you.",
          (audioChunk: string) => {
            if (!stopRequestedRef.current) {
              playback.pushAudio(audioChunk);
            }
          },
          { voice: voiceGenderRef.current },
        )
          .then(() => {
            if (!stopRequestedRef.current) playback.signalComplete();
          })
          .catch(() => {});
      });

      const transcript = await transcribeAudio(blob);

      if (!transcript) {
        setMessages((prev) => prev.filter((m) => m.id !== hearYouId));
        setIsProcessing(false);
        return;
      }

      const userId = nextId();
      const assistantId = nextId();

      setMessages((prev) => [
        ...prev.filter((m) => m.id !== hearYouId),
        { id: userId, role: "user", text: transcript },
        { id: assistantId, role: "assistant", text: "" },
      ]);

      let assistantText = "";

      await sendChat(
        conversationIdRef.current,
        transcript,
        (id) => {
          conversationIdRef.current = id;
          setConversationId(id);
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

      stopRequestedRef.current = false;
      await playback.init();
      setIsSpeaking(true);

      lastAudioChunksRef.current = [];

      await streamTTS(
        assistantText,
        (audioChunk: string) => {
          if (!stopRequestedRef.current) {
            lastAudioChunksRef.current.push(audioChunk);
            playback.pushAudio(audioChunk);
          }
        },
        { voice: voiceGenderRef.current },
      );

      if (!stopRequestedRef.current) {
        playback.signalComplete();
      }
    } catch (err) {
      console.error("Voice interaction failed:", err);
    } finally {
      setIsProcessing(false);
    }
  }, [isSpeaking, isProcessing, isRecording, playback, recorder]);

  /* =====================================================
     RENDER
  ===================================================== */

  return (
    <div className="min-h-screen w-full bg-black relative overflow-hidden">
      {mode === "A" ? (
        <>
          {/* Logo + label: absolutely centered on screen */}
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ paddingBottom: "80px" }}
          >
            {/* Wrapper that is exactly the CentralForm size so we can overlay the label */}
            <div
              className="relative"
              style={{ width: "600px", height: "600px", cursor: "pointer" }}
              onClick={handleTap}
            >
              <CentralForm
                isActive={isRecording || isProcessing || isSpeaking}
                isDimmed={false}
                isSpeaking={isSpeaking}
                getAmplitude={playback.getAmplitude}
              />
              {/* Label centered inside the logo */}
              <span
                className="absolute inset-0 flex items-center justify-center text-sm text-gray-400"
                style={{ pointerEvents: "none" }}
              >
                {isRecording
                  ? "Listening..."
                  : isProcessing
                    ? "Reflecting..."
                    : isSpeaking
                      ? "Stop"
                      : "Press here"}
              </span>
            </div>
          </div>

          {/* Case Review: top left */}
          <div className="absolute top-4 left-4">
            <button
              onClick={(e) => {
                e.stopPropagation();
                runCaseReview();
              }}
              className="text-sm text-gray-400 hover:text-white"
            >
              Case review
            </button>
          </div>

          {/* Bottom bar: pinned to bottom, always visible */}
          <div className="absolute bottom-12 left-0 right-0 flex justify-between px-8">
            <div onClick={() => setMode("B")} className="cursor-pointer">
              <p className="text-lg text-gray-500 hover:text-white">
                Prefer typing?
              </p>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setVoiceGender((prev) => (prev === "male" ? "female" : "male"));
              }}
              className="text-sm text-gray-400 hover:text-white"
            >
              Prefer {voiceGender === "female" ? "male" : "female"}
            </button>
            {lastResponse ? (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  repeatLast();
                }}
                className="cursor-pointer"
              >
                <p className="text-lg text-gray-500 hover:text-white">
                  Repeat response
                </p>
              </div>
            ) : (
              <div />
            )}
          </div>
        </>
      ) : (
        <ChatView
          messages={messages}
          setMessages={setMessages}
          playback={playback}
          lastAudioChunksRef={lastAudioChunksRef}
          voiceGender={voiceGender}
          onBack={() => setMode("A")}
        />
      )}
    </div>
  );
}

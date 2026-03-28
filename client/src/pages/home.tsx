import { useState, useRef, useEffect, useCallback } from "react";
import { CentralForm } from "@/components/central-form";
import { ChatView } from "@/components/chat-view";
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

export default function Home() {
  const [mode, setMode] = useState<"A" | "B">("A");
  const [conversationId, setConversationId] = useState<number | null>(null);
  const conversationIdRef = useRef<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasExchanged, setHasExchanged] = useState(false);

  const playback = useAudioPlayback();
  const recorder = useVoiceRecorder();

  // playUITone takes no arguments — correct interface
  const playUITone = useCallback(() => {}, []);

  /* ================= CONVERSATION LOAD ================= */
  useEffect(() => {
    async function loadConversation() {
      try {
        let conversationIdToUse: number | null = null;

        const storedId = localStorage.getItem("conversationId");
        if (storedId && Number.isFinite(Number(storedId))) {
          conversationIdToUse = Number(storedId);
        } else {
          const resp = await fetch("/api/conversations", {
            credentials: "include",
          });
          if (!resp.ok) return;
          const convs = await resp.json();
          if (Array.isArray(convs) && convs.length > 0) {
            conversationIdToUse = Number(convs[0].id);
          }
        }

        if (!conversationIdToUse) return;

        const msgResp = await fetch(`/api/messages/${conversationIdToUse}`, {
          credentials: "include",
        });
        if (!msgResp.ok) return;
        const rows = await msgResp.json();
        if (!Array.isArray(rows)) return;

        conversationIdRef.current = conversationIdToUse;
        setConversationId(conversationIdToUse);
        localStorage.setItem("conversationId", String(conversationIdToUse));

        const loaded = rows.map((m: any) => ({
          id: String(m.id),
          role: m.role,
          text: m.content,
        }));

        setMessages(loaded);
        messageCounter = loaded.length;

        if (loaded.some((m) => m.role === "user")) {
          setHasExchanged(true);
        }
      } catch (err) {
        console.error("Load conversation failed:", err);
      }
    }

    loadConversation();
  }, []);

  return (
    <div className="min-h-screen bg-black">
      {mode === "B" ? (
        <ChatView
          messages={messages}
          setMessages={setMessages}
          playback={playback}
          voiceGender="female"
          onBack={() => setMode("A")}
          lastAudioChunksRef={{ current: [] }}
          playUITone={playUITone}
          // Single source of truth: Home owns the conversationId
          conversationId={conversationId}
          onConversationId={(id) => {
            conversationIdRef.current = id;
            setConversationId(id);
            localStorage.setItem("conversationId", String(id));
          }}
        />
      ) : (
        <div className="min-h-screen flex items-center justify-center">
          <div
            className="cursor-pointer"
            onClick={async () => {
              try {
                await playback.init();
                playUITone();
                setMode("B");
              } catch (err) {
                console.error("Mode A interaction failed:", err);
              }
            }}
          >
            <CentralForm isActive={true} isDimmed={false} isSpeaking={false} />
          </div>
        </div>
      )}
    </div>
  );
}

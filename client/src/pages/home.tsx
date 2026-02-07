import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CentralForm } from "@/components/central-form";
import { ChatView, type Message } from "@/components/chat-view";

let messageCounter = 0;
function nextId() {
  return String(++messageCounter);
}

export default function Home() {
  const [hasStarted, setHasStarted] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [mode, setMode] = useState<"voice" | "text">("voice");
  const [showTypeOption, setShowTypeOption] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowTypeOption(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  const seedOnboarding = useCallback(() => {
    if (messages.length === 0) {
      setMessages([
        {
          id: nextId(),
          role: "assistant",
          text: "What would you like me to call you?",
        },
      ]);
    }
  }, [messages.length]);

  const handleInteraction = () => {
    if (mode === "text") return;

    if (!hasStarted) {
      setHasStarted(true);
      setIsActive(true);
      setShowTypeOption(false);
    } else {
      setIsActive(!isActive);
    }
  };

  const handleTextMode = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMode("text");
    setIsActive(false);
    setHasStarted(true);
    setShowTypeOption(false);
    seedOnboarding();
  };

  const handleSendMessage = (text: string) => {
    setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);
  };

  const handleBackToVoice = () => {
    setMode("voice");
    setHasStarted(false);
    setIsActive(false);
    setShowTypeOption(true);
  };

  if (mode === "text") {
    return (
      <ChatView
        messages={messages}
        onSendMessage={handleSendMessage}
        onBack={handleBackToVoice}
      />
    );
  }

  return (
    <div
      className="min-h-screen w-full flex flex-col items-center justify-center overflow-hidden cursor-pointer select-none bg-black relative"
      onClick={handleInteraction}
    >
      <div
        className="flex-1 flex flex-col items-center justify-center relative w-full transition-all duration-1000"
      >
        <CentralForm isActive={isActive} isDimmed={false} />

        <AnimatePresence>
          {!hasStarted && (
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
      </div>

      <AnimatePresence>
        {showTypeOption && mode === "voice" && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.85 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.5, ease: "easeInOut" }}
            className="absolute bottom-12 md:bottom-16 pointer-events-auto"
            onClick={handleTextMode}
          >
            <p
              className="text-lg font-medium text-[#858585] leading-relaxed hover:text-[#a3a3a3] transition-colors duration-300"
              data-testid="link-prefer-typing"
            >
              Prefer typing?
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

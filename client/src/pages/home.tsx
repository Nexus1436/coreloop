import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CentralForm } from "@/components/central-form";

type AppState = "idle" | "listening" | "processing" | "speaking";

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [transcript, setTranscript] = useState<string[]>([]);

  // Simulation logic (same as before, but without visual clutter)
  useEffect(() => {
    let timeout: NodeJS.Timeout;

    if (state === "listening") {
      timeout = setTimeout(() => {
        setState("processing");
      }, 4000); // Slower, calmer timing
    } else if (state === "processing") {
      timeout = setTimeout(() => {
        setState("speaking");
        setTranscript(prev => [...prev, "I hear you."]);
      }, 2000);
    } else if (state === "speaking") {
      timeout = setTimeout(() => {
        setState("idle");
      }, 3000);
    }

    return () => clearTimeout(timeout);
  }, [state]);

  const handleInteraction = () => {
    // Toggle interaction - minimal feedback
    if (state === "idle") {
      setState("listening");
    } else if (state === "listening") {
      setState("idle");
    }
  };

  return (
    <div 
      className="min-h-screen w-full flex flex-col items-center justify-center overflow-hidden cursor-pointer"
      onClick={handleInteraction}
    >
      {/* No Header, No Footer, No Controls */}
      
      {/* Central Focal Element */}
      <div className="flex-1 flex flex-col items-center justify-center relative w-full max-w-lg mx-auto">
        <CentralForm state={state} />

        {/* Suspended Content / Transcript */}
        {/* "Text should feel spoken, not instructional" */}
        <div className="absolute top-1/2 mt-32 w-full text-center px-8 pointer-events-none">
          <AnimatePresence mode="wait">
            {transcript.length > 0 && state !== "listening" && state !== "processing" && (
              <motion.p
                key={transcript.length}
                initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: "blur(8px)", transition: { duration: 1 } }}
                transition={{ duration: 1.5, ease: "easeOut" }}
                className="text-lg md:text-xl font-medium text-foreground tracking-wide leading-relaxed"
              >
                {transcript[transcript.length - 1]}
              </motion.p>
            )}
            
            {/* Extremely subtle hint if absolutely necessary, otherwise silence */}
            {/* The prompt says "No instructional copy". So we render nothing when idle. */}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

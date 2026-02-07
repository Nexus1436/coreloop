import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, Square, MoreHorizontal } from "lucide-react";
import { AudioVisualizer, PulseIndicator } from "@/components/audio-visualizer";
import { Button } from "@/components/ui/button";

type AppState = "idle" | "listening" | "processing" | "speaking";

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [transcript, setTranscript] = useState<string[]>([]);

  // Simulate conversation flow for the mockup
  useEffect(() => {
    let timeout: NodeJS.Timeout;

    if (state === "listening") {
      timeout = setTimeout(() => {
        setState("processing");
      }, 3000);
    } else if (state === "processing") {
      timeout = setTimeout(() => {
        setState("speaking");
        setTranscript(prev => [...prev, "I'm listening. Take your time."]);
      }, 1500);
    } else if (state === "speaking") {
      timeout = setTimeout(() => {
        setState("idle");
      }, 3000);
    }

    return () => clearTimeout(timeout);
  }, [state]);

  const toggleSession = () => {
    if (state === "idle") {
      setState("listening");
    } else {
      setState("idle");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-foreground/10 flex flex-col items-center justify-between p-6 md:p-12 overflow-hidden transition-colors duration-700">
      
      {/* Header / Status */}
      <header className="w-full max-w-2xl flex justify-between items-center opacity-60">
        <div className="flex items-center gap-2">
           <div className={`w-1.5 h-1.5 rounded-full ${state !== 'idle' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-foreground/20'}`} />
           <span className="text-xs font-mono uppercase tracking-widest text-foreground/60">
             {state === "idle" ? "Ready" : state}
           </span>
        </div>
        <div className="text-xs font-mono text-foreground/40">Interloop v1.0</div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 w-full max-w-2xl flex flex-col items-center justify-center relative">
        
        {/* Central Visual */}
        <div className="relative z-10 mb-12 h-40 flex items-center justify-center">
          {state === "idle" ? (
             <motion.div 
               initial={{ opacity: 0 }} 
               animate={{ opacity: 1 }} 
               className="w-24 h-1 bg-foreground/10 rounded-full"
             />
          ) : (
             <AudioVisualizer isActive={state === "listening" || state === "speaking"} />
          )}
        </div>

        {/* Conversation / Transcript - Fading text */}
        <div className="w-full text-center space-y-6 min-h-[120px]">
          <AnimatePresence mode="popLayout">
            {state === "processing" && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="text-foreground/40 text-sm font-mono flex items-center justify-center gap-2"
              >
                <MoreHorizontal className="w-4 h-4 animate-pulse" />
                Thinking
              </motion.div>
            )}
            
            {transcript.length > 0 && state !== "processing" && (
              <motion.p
                key={transcript.length}
                initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                className="text-2xl md:text-3xl font-light text-foreground/90 leading-relaxed text-balance"
              >
                "{transcript[transcript.length - 1]}"
              </motion.p>
            )}

            {transcript.length === 0 && state === "idle" && (
              <motion.p
                 initial={{ opacity: 0 }}
                 animate={{ opacity: 1 }}
                 transition={{ delay: 0.5 }}
                 className="text-foreground/30 text-lg font-light"
              >
                Tap to speak
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Controls */}
      <footer className="w-full max-w-2xl flex justify-center pb-8 relative">
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <PulseIndicator isActive={state === "listening"} />
        </div>

        <motion.button
          onClick={toggleSession}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className={`
            relative z-20 w-20 h-20 rounded-full flex items-center justify-center
            transition-all duration-500 ease-out
            ${state === 'listening' 
              ? 'bg-foreground text-background shadow-xl' 
              : 'bg-secondary text-foreground hover:bg-foreground/5'
            }
          `}
          data-testid="button-mic"
        >
          <AnimatePresence mode="wait">
            {state === "listening" ? (
              <motion.div
                key="stop"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
              >
                <Square className="w-6 h-6 fill-current" />
              </motion.div>
            ) : (
              <motion.div
                key="mic"
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.5, opacity: 0 }}
              >
                <Mic className="w-8 h-8 stroke-[1.5]" />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.button>
      </footer>
    </div>
  );
}

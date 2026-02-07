import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CentralForm } from "@/components/central-form";

export default function Home() {
  const [hasStarted, setHasStarted] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [mode, setMode] = useState<'voice' | 'text'>('voice');
  const [showTypeOption, setShowTypeOption] = useState(false);

  useEffect(() => {
    // Show "Prefer typing?" option after 3 seconds
    const timer = setTimeout(() => {
      setShowTypeOption(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  const handleInteraction = () => {
    if (mode === 'text') return; // Do nothing if in text mode

    if (!hasStarted) {
      setHasStarted(true);
      // First tap activates "listening/recording" state for the orb
      setIsActive(true);
      // Fade out the typing option if voice interaction starts
      setShowTypeOption(false);
    } else {
      // Toggle active state for demo purposes (or keep it active if it's a listening session)
      setIsActive(!isActive);
    }
  };

  const handleTextMode = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering the main click handler
    setMode('text');
    setIsActive(false); // Dim/Pause pulse
    setHasStarted(true); // Remove "I hear you" if present
    setShowTypeOption(false); // Remove the option itself
  };

  return (
    <div 
      className="min-h-screen w-full flex flex-col items-center justify-center overflow-hidden cursor-pointer select-none bg-black relative"
      onClick={handleInteraction}
    >
      {/* Central Focal Element (Logo + Pulse) - Always visible */}
      {/* Passing active state to control breath intensity */}
      {/* Passing isDimmed to control opacity during text mode */}
      <div className={`flex-1 flex flex-col items-center justify-center relative w-full transition-all duration-1000 ${mode === 'text' ? 'mb-32' : ''}`}>
        <CentralForm isActive={isActive} isDimmed={mode === 'text'} />

        {/* "I hear you." - Initial state only */}
        {/* Same charcoal tone as pulse: rgba(58,58,58) */}
        <AnimatePresence>
          {!hasStarted && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.75 }}
              exit={{ opacity: 0, transition: { duration: 0.6, ease: "easeOut" } }}
              transition={{ duration: 2, delay: 0.5 }}
              className="absolute pointer-events-none"
            >
              <p className="text-sm md:text-base font-light text-[#EFEFEF] tracking-wide text-center">
                I hear you.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Text Mode Input Interface */}
      <AnimatePresence>
        {mode === 'text' && (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="absolute bottom-1/4 w-full max-w-lg px-8 flex flex-col items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <textarea 
              className="w-full bg-transparent text-[#EFEFEF] text-xl md:text-2xl font-light text-center border-none outline-none resize-none placeholder-[#333]"
              placeholder=""
              autoFocus
              rows={1}
              style={{ caretColor: '#EFEFEF' }}
              // Simple auto-resize logic could be added here
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* "Prefer typing?" Option */}
      <AnimatePresence>
        {showTypeOption && mode === 'voice' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.7 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.5, ease: "easeInOut" }}
            className="absolute bottom-12 md:bottom-16 pointer-events-auto"
            onClick={handleTextMode}
          >
            <p className="text-sm font-light text-[#525252] hover:text-[#737373] transition-colors duration-300">
              Prefer typing?
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

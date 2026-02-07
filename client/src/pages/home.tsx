import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CentralForm } from "@/components/central-form";

export default function Home() {
  const [hasStarted, setHasStarted] = useState(false);
  const [isActive, setIsActive] = useState(false);

  const handleInteraction = () => {
    if (!hasStarted) {
      setHasStarted(true);
      // First tap activates "listening/recording" state for the orb
      setIsActive(true);
    } else {
      // Toggle active state for demo purposes (or keep it active if it's a listening session)
      setIsActive(!isActive);
    }
  };

  return (
    <div 
      className="min-h-screen w-full flex flex-col items-center justify-center overflow-hidden cursor-pointer select-none bg-black"
      onClick={handleInteraction}
    >
      {/* Central Focal Element (Logo + Pulse) - Always visible */}
      {/* Passing active state to control breath intensity */}
      <div className="flex-1 flex flex-col items-center justify-center relative w-full">
        <CentralForm isActive={isActive} />

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
    </div>
  );
}

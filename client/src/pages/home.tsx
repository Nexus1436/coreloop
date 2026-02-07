import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CentralForm } from "@/components/central-form";

export default function Home() {
  const [hasStarted, setHasStarted] = useState(false);

  const handleInteraction = () => {
    if (!hasStarted) {
      setHasStarted(true);
    }
  };

  return (
    <div 
      className="min-h-screen w-full flex flex-col items-center justify-center overflow-hidden cursor-pointer select-none bg-black"
      onClick={handleInteraction}
    >
      {/* Central Focal Element (Logo + Pulse) - Always visible */}
      <div className="flex-1 flex flex-col items-center justify-center relative w-full">
        <CentralForm />

        {/* "I hear you." - Initial state only */}
        <AnimatePresence>
          {!hasStarted && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 1.5, ease: "easeOut" } }}
              transition={{ duration: 2, delay: 0.5 }}
              className="absolute pointer-events-none"
            >
              <p className="text-sm md:text-base font-medium text-[#525252] tracking-wide text-center">
                I hear you.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

import { motion } from "framer-motion";

interface VisualStateProps {
  state: "idle" | "listening" | "processing" | "speaking";
}

export function CentralForm({ state }: VisualStateProps) {
  // The "Soft, circular form"
  // It pulses slowly. It never gets "techy" or rhythmic.
  
  return (
    <div className="relative flex items-center justify-center w-96 h-96 pointer-events-none">
      {/* Base form - soft charcoal circle, barely visible */}
      <motion.div
        className="absolute w-48 h-48 rounded-full bg-subtle blur-3xl opacity-20"
        animate={{
          scale: state === "listening" ? [1, 1.1, 1] : 1,
          opacity: state === "listening" ? [0.2, 0.3, 0.2] : 0.2,
        }}
        transition={{
          duration: 6,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />

      {/* Inner core - slightly more defined but still soft */}
      <motion.div
        className="w-32 h-32 rounded-full bg-[#1a1a1a]"
        animate={{
          scale: state === "listening" ? 1.05 : 1,
          backgroundColor: state === "processing" ? "#222" : "#1a1a1a",
        }}
        transition={{
          duration: 4,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* Speaking State - A very subtle glow or expansion, not a waveform */}
      {state === "speaking" && (
         <motion.div
            className="absolute inset-0 rounded-full bg-white/5 blur-3xl"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.2, 0] }}
            transition={{ duration: 4, repeat: Infinity }}
         />
      )}
    </div>
  );
}

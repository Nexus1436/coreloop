import { motion } from "framer-motion";

export function CentralForm({ isActive = false }: { isActive?: boolean }) {
  // INTERLOOP — BREATH / PULSE CANONICAL SPEC
  // Core Principle: Pulse represents breath and attention. Biological, non-mechanical.
  
  // Timing: 6.5s cycle. Inhale ~3.8s, Exhale ~2.7s.
  // Expansion (Inhale): 1.3 - 1.5x logo diameter.
  // Contraction (Exhale): 0.15 - 0.2 scale.
  
  // Opacity Curve: Inverse relationship to size.
  // Small = slightly visible (never > 40%).
  // Large = barely visible (< 25%).
  
  // Failure Condition Check:
  // - No visible "ball" formation -> Ensure blur is always present.
  // - Pulse expands BEYOND logo -> Max scale 1.5.
  // - Opacity decreases on expansion.
  
  return (
    <div className="relative flex items-center justify-center w-[600px] h-[600px] pointer-events-none">
      
      {/* --- LAYER 1: PULSE (BREATH) --- */}
      {/* Exists behind and through the logo. Never clipped. */}
      <div className="absolute inset-0 flex items-center justify-center z-0">
        
        {/* The Breath Pulse */}
        <motion.div
          className="absolute rounded-full bg-[rgba(58,58,58,1)]"
          style={{ 
            width: "250px", // Base size, will scale up/down from here
            height: "250px",
          }}
          initial={{ scale: 0.2, opacity: 0.1, filter: "blur(4px)" }}
          animate={{ 
            scale: [0.2, 1.5, 0.2], // Contracted (0.2) -> Expanded beyond logo (1.5) -> Contracted
            opacity: [0.35, 0.1, 0.35], // Small=More visible (35%), Large=Less visible (10%)
            filter: ["blur(4px)", "blur(32px)", "blur(4px)"] // Blur increases with expansion
          }}
          transition={{
            duration: 6.5,
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.58, 1] // Inhale ~3.8s (58%), Exhale ~2.7s (42%)
          }}
        />
        
        {/* Secondary Diffusion Layer - To ensure no "ball" look and softer edges */}
        <motion.div
          className="absolute rounded-full bg-[rgba(58,58,58,1)]"
          style={{ 
            width: "250px",
            height: "250px",
          }}
          initial={{ scale: 0.25, opacity: 0, filter: "blur(8px)" }}
          animate={{ 
            scale: [0.25, 1.4, 0.25],
            opacity: [0.2, 0.05, 0.2],
            filter: ["blur(8px)", "blur(40px)", "blur(8px)"]
          }}
          transition={{
            duration: 6.5,
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.58, 1],
            delay: 0.1 // Slight offset for organic feel
          }}
        />
      </div>

      {/* --- LAYER 2: LOGO LAYER (STATIC) --- */}
      {/* Static. Charcoal. Opacity ~85-90%. */}
      <div 
        className="relative z-10 w-64 h-64 md:w-80 md:h-80 flex items-center justify-center"
      >
         <img 
           src="/logo.png" 
           alt="Interloop Logo" 
           className="w-full h-full object-contain"
           style={{ 
             opacity: 0.88,
             filter: "grayscale(100%) brightness(0.8)", 
             mixBlendMode: "screen" 
           }} 
         />
      </div>

    </div>
  );
}

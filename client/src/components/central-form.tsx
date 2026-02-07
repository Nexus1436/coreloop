import { motion } from "framer-motion";

export function CentralForm({ isActive = false }: { isActive?: boolean }) {
  // INTERLOOP — BREATH / PULSE CANONICAL SPEC
  // Core Principle: Pulse represents breath and attention. Biological, non-mechanical.
  
  // Timing: 9.5s cycle. Inhale ~5.5s, Exhale ~4s.
  // Expansion (Inhale): 1.3 - 1.5x logo diameter.
  // Contraction (Exhale): 0.15 - 0.2 scale.
  
  // Opacity Curve: Inverse relationship to size.
  // Small = slightly visible (never > 40%).
  // Large = barely visible (< 25%).
  
  // Orb Contraction Adjustment:
  // - Exhale phase only: Prevent uniform circular contraction.
  // - Mild asymmetry and edge entropy.
  // - Must not resolve into a clean circle at minimum size.
  
  return (
    <div className="relative flex items-center justify-center w-[600px] h-[600px] pointer-events-none">
      
      {/* --- LAYER 1: PULSE (BREATH) --- */}
      {/* Exists behind and through the logo. Never clipped. */}
      <div className="absolute inset-0 flex items-center justify-center z-0">
        
        {/* The Breath Pulse */}
        <motion.div
          className="absolute bg-[rgba(58,58,58,1)]"
          style={{ 
            width: "250px", // Base size, will scale up/down from here
            height: "250px",
          }}
          initial={{ scale: 0.2, opacity: 0.1, filter: "blur(4px)", borderRadius: "50%" }}
          animate={{ 
            scale: [0.2, 1.5, 0.2], // Contracted (0.2) -> Expanded beyond logo (1.5) -> Contracted
            opacity: [0.35, 0.1, 0.35], // Small=More visible (35%), Large=Less visible (10%)
            filter: ["blur(4px)", "blur(32px)", "blur(4px)"], // Blur increases with expansion
            borderRadius: [
                "40% 60% 45% 55% / 55% 45% 60% 40%", // Irregular start
                "50%", // Perfect circle at peak expansion
                "55% 45% 60% 40% / 40% 60% 45% 55%"  // Different irregular end for entropy
            ],
            rotate: [0, 0, 90] // Subtle rotation adds to the entropy during contraction
          }}
          transition={{
            duration: 9.5,
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.58, 1] // Inhale ~5.5s, Exhale ~4s
          }}
        />
        
        {/* Secondary Diffusion Layer - To ensure no "ball" look and softer edges */}
        <motion.div
          className="absolute bg-[rgba(58,58,58,1)]"
          style={{ 
            width: "250px",
            height: "250px",
          }}
          initial={{ scale: 0.25, opacity: 0, filter: "blur(8px)", borderRadius: "50%" }}
          animate={{ 
            scale: [0.25, 1.4, 0.25],
            opacity: [0.2, 0.05, 0.2],
            filter: ["blur(8px)", "blur(40px)", "blur(8px)"],
            borderRadius: [
                "60% 40% 55% 45% / 45% 55% 40% 60%", // Irregular start (offset from layer 1)
                "50%", // Perfect circle at peak
                "45% 55% 40% 60% / 60% 40% 55% 45%"  // Irregular end
            ],
            rotate: [0, 0, -45] // Counter-rotation
          }}
          transition={{
            duration: 9.5,
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

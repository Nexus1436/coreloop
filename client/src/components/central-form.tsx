import { motion } from "framer-motion";

export function CentralForm({ isActive = false }: { isActive?: boolean }) {
  // Pulse / Orb Implementation (Canonical)
  // Type: Breath-based orb (not waveform, not rings)
  // Rhythm: 6.5s cycle (inhale + exhale)
  
  // Colors - Charcoal / Graphite
  // Base: rgba(58, 58, 58)
  
  return (
    <div className="relative flex items-center justify-center w-[600px] h-[600px] pointer-events-none">
      
      {/* --- LAYER 1: PULSE ORB (BREATHING) --- */}
      {/* Continuous. Never paused. Never removed. */}
      {/* Center of the screen, z-0 */}
      <div className="absolute inset-0 flex items-center justify-center z-0">
        
        {/* Soft Background Glow */}
        {/* Idle: 3% -> 6% opacity */}
        {/* Active: ~20% opacity */}
        <motion.div
          className="absolute rounded-full bg-[rgba(58,58,58,1)] blur-3xl"
          initial={{ width: "300px", height: "300px", opacity: 0.03 }}
          animate={{ 
            opacity: isActive ? [0.15, 0.25, 0.15] : [0.03, 0.06, 0.03],
            scale: isActive ? [1, 1.1, 1] : [1, 1.05, 1]
          }}
          transition={{
            duration: 6.5,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />

        {/* Inner Orb - The Core Breath */}
        {/* Idle: 1.0 -> 1.02 scale, 50% -> 65% opacity */}
        {/* Active: 1.0 -> 1.03 scale, 70% -> 90% opacity */}
        <motion.div
          className="absolute rounded-full bg-[rgba(58,58,58,1)] blur-xl"
          initial={{ width: "220px", height: "220px", opacity: 0.5 }}
          animate={{ 
            scale: isActive ? [1, 1.03, 1] : [1, 1.02, 1],
            opacity: isActive ? [0.7, 0.9, 0.7] : [0.5, 0.65, 0.5]
          }}
          transition={{
            duration: 6.5,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      </div>

      {/* --- LAYER 2: LOGO LAYER (STATIC) --- */}
      {/* Sits above the pulse. Must not mask/clip. */}
      {/* Container Opacity: 35%. Image Opacity: 88%. */}
      <div 
        className="relative z-10 w-64 h-64 md:w-80 md:h-80 flex items-center justify-center"
        style={{ opacity: 0.35 }}
      >
         <img 
           src="/logo.png" 
           alt="Interloop Logo" 
           className="w-full h-full object-contain"
           style={{ 
             opacity: 0.88,
             filter: "grayscale(100%) brightness(0.8)", 
             // mixBlendMode helps it integrate without blocking the glow completely
             mixBlendMode: "screen" 
           }} 
         />
      </div>

    </div>
  );
}

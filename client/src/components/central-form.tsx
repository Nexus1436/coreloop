import { motion } from "framer-motion";

export function CentralForm({ isActive = false }: { isActive?: boolean }) {
  // Breath Core Revision (Chi-Field Model)
  // Rhythm: 6.5s cycle
  
  // Inhale (Expansion): 
  // Scale 0.08 -> 1.0
  // Opacity 0.85 -> 0.55
  // "Something opening because it must"
  
  // Exhale (Contraction):
  // Scale 1.0 -> 0.08
  // Opacity 0.55 -> 0.85
  // "Energy gathering, not disappearing"
  
  // Center becomes visually dense, almost a dot (0.08 scale)
  
  return (
    <div className="relative flex items-center justify-center w-[600px] h-[600px] pointer-events-none">
      
      {/* --- LAYER 1: PULSE (CHI-FIELD) --- */}
      {/* Contained inside the logo vessel */}
      <div className="absolute inset-0 flex items-center justify-center z-0">
        
        {/* The Core Breath */}
        {/* Base size set to approximately fit the logo opening at scale 1.0 */}
        <motion.div
          className="absolute rounded-full bg-[rgba(58,58,58,1)]"
          style={{ 
            width: "180px", 
            height: "180px",
          }}
          initial={{ scale: 0.08, opacity: 0.85, filter: "blur(2px)" }}
          animate={{ 
            scale: [0.08, 1.0, 0.08],
            opacity: [0.85, 0.55, 0.85],
            filter: ["blur(2px)", "blur(12px)", "blur(2px)"]
          }}
          transition={{
            duration: 6.5,
            repeat: Infinity,
            ease: "easeInOut", // Ease-in / ease-out timing
            times: [0, 0.5, 1] // 0 (start/contracted) -> 0.5 (expanded) -> 1 (contracted)
          }}
        />
      </div>

      {/* --- LAYER 2: LOGO LAYER (STATIC VESSEL) --- */}
      {/* Acts as a static vessel. No expansion beyond logo edge. */}
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
             mixBlendMode: "screen" 
           }} 
         />
      </div>

    </div>
  );
}

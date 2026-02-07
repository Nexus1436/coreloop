import { motion } from "framer-motion";

export function CentralForm({ isActive = false, isDimmed = false }: { isActive?: boolean; isDimmed?: boolean }) {
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
    <div 
        className="relative flex items-center justify-center w-[600px] h-[600px] pointer-events-none transition-opacity duration-1000 ease-in-out"
        style={{ opacity: isDimmed ? 0.3 : 1 }}
    >
      
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
            // Cycle: Full Breath (12s)
            // Start (Full Expansion) -> Inhale (Contract) -> Smallest Point -> Exhale (Expand) -> End (Full Expansion)
            // Inhale: 3.5s / 12s = 0.29
            // Pause: 0.5s / 12s = 0.04 -> End at 0.33
            // Exhale: 8s / 12s = 0.67 -> End at 1.0
            
            scale: [0.95, 0.25, 0.25, 0.95], 
            opacity: [0.55, 0.05, 0.05, 0.55], // Visible at full size, Fades to near-zero at center
            filter: ["blur(45px)", "blur(25px)", "blur(25px)", "blur(45px)"], // Fog-like at full size, still blurred at center
            borderRadius: [
                "45% 55% 40% 60% / 60% 40% 55% 45%", // Dispersed shape (Full)
                "60% 40% 30% 70% / 50% 60% 30% 40%", // Cloud-like collapse (Small)
                "60% 40% 30% 70% / 50% 60% 30% 40%", // Turnaround
                "45% 55% 40% 60% / 60% 40% 55% 45%"  // Dispersed shape (Full)
            ],
            rotate: [0, 90, 90, 0] 
          }}
          transition={{
            duration: 12,
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.29, 0.33, 1] // Inhale(3.5s), Pause(0.5s), Exhale(8s)
          }}
        />
        
        {/* Secondary Diffusion Layer - Adds complexity and entropy */}
        <motion.div
          className="absolute bg-[rgba(58,58,58,1)]"
          style={{ 
            width: "250px",
            height: "250px",
          }}
          initial={{ scale: 1.0, opacity: 0.5, filter: "blur(40px)", borderRadius: "50%" }}
          animate={{ 
            scale: [1.0, 0.3, 0.3, 1.0],
            opacity: [0.45, 0.02, 0.02, 0.45],
            filter: ["blur(50px)", "blur(30px)", "blur(30px)", "blur(50px)"],
            borderRadius: [
                "55% 45% 60% 40% / 40% 60% 45% 55%", 
                "40% 60% 70% 30% / 60% 30% 70% 40%", 
                "40% 60% 70% 30% / 60% 30% 70% 40%", 
                "55% 45% 60% 40% / 40% 60% 45% 55%"
            ],
            rotate: [0, -45, -45, 0] 
          }}
          transition={{
            duration: 12,
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.29, 0.33, 1],
            delay: 0.1 
          }}
        />
        
        {/* Secondary Diffusion Layer - Adds complexity and entropy */}
        <motion.div
          className="absolute bg-[rgba(58,58,58,1)]"
          style={{ 
            width: "250px",
            height: "250px",
          }}
          initial={{ scale: 1.0, opacity: 0.5, filter: "blur(40px)", borderRadius: "50%" }}
          animate={{ 
            scale: [1.0, 0.3, 0.3, 1.0],
            opacity: [0.45, 0.02, 0.02, 0.45],
            filter: ["blur(50px)", "blur(30px)", "blur(30px)", "blur(50px)"],
            borderRadius: [
                "55% 45% 60% 40% / 40% 60% 45% 55%", 
                "40% 60% 70% 30% / 60% 30% 70% 40%", 
                "40% 60% 70% 30% / 60% 30% 70% 40%", 
                "55% 45% 60% 40% / 40% 60% 45% 55%"
            ],
            rotate: [0, -45, -45, 0] 
          }}
          transition={{
            duration: 12,
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.29, 0.33, 1],
            delay: 0.1 
          }}
        />
      </div>

      {/* --- FILTER DEFINITION --- */}
      {/* SVG Filter for "Beveled Charcoal" Effect */}
      {/* Creates a matte, pressed-in look with graphite tones and soft inner shadows */}
      <svg width="0" height="0" className="absolute">
        <filter id="pressed-charcoal" x="-50%" y="-50%" width="200%" height="200%">
          
          {/* 1. Base Alpha Map (Preserves texture) */}
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="alphaMap"/>

          {/* 2. Inner Shadow Construction (For "Pressed" depth) */}
          <feGaussianBlur in="alphaMap" stdDeviation="1.5" result="blurredAlpha"/>
          <feOffset in="blurredAlpha" dx="1" dy="2" result="offsetBlurredAlpha"/>
          
          {/* Create the inner rim by cutting out the offset blur from the sharp alpha */}
          <feComposite operator="out" in="alphaMap" in2="offsetBlurredAlpha" result="innerShadowMask"/>
          
          {/* Colorize Inner Shadow (Darker Graphite) */}
          <feFlood flood-color="#2d2d2d" result="shadowColor"/>
          <feComposite operator="in" in="shadowColor" in2="innerShadowMask" result="innerShadow"/>

          {/* 3. Base Fill (Soft Charcoal #555555) */}
          <feFlood flood-color="#555555" result="baseColor"/>
          <feComposite operator="in" in="baseColor" in2="alphaMap" result="flatBase"/>

          {/* 4. Highlight (Subtle bottom-right inner highlight for matte tactility) */}
          <feOffset in="blurredAlpha" dx="-1" dy="-2" result="offsetHighlight"/>
          <feComposite operator="out" in="alphaMap" in2="offsetHighlight" result="highlightMask"/>
          <feFlood flood-color="#6a6a6a" result="highlightColor"/>
          <feComposite operator="in" in="highlightColor" in2="highlightMask" result="innerHighlight"/>

          {/* 5. Composite Layers */}
          {/* Base -> Inner Shadow -> Inner Highlight */}
          <feMerge>
            <feMergeNode in="flatBase"/>
            <feMergeNode in="innerShadow"/>
            <feMergeNode in="innerHighlight"/>
          </feMerge>
        </filter>
      </svg>

      {/* --- LAYER 2: LOGO LAYER (STATIC) --- */}
      {/* Static. Charcoal. Opacity ~85-90%. */}
      {/* Uses the custom SVG filter for the pressed charcoal look. */}
      <div 
        className="relative z-10 w-64 h-64 md:w-80 md:h-80 flex items-center justify-center"
      >
         <img 
           src="/logo.png" 
           alt="Interloop Logo" 
           className="w-full h-full object-contain"
           style={{ 
             opacity: 0.88,
             filter: "url(#pressed-charcoal)",
             // Removed mixBlendMode and previous filters to rely entirely on the SVG filter
           }} 
         />
      </div>

    </div>
  );
}

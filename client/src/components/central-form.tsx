import { motion } from "framer-motion";

export function CentralForm() {
  // Layering Architecture:
  // Layer 0: Background (handled by parent/body)
  // Layer 1: Pulse Layer (Absolute, centered, z-0)
  // Layer 2: Logo Layer (Absolute, centered, z-10)

  return (
    <div className="relative flex items-center justify-center w-[600px] h-[600px] pointer-events-none">
      
      {/* --- LAYER 1: PULSE LAYER --- */}
      {/* Continuous expanding radial waves. Independent of logo. */}
      <div className="absolute inset-0 flex items-center justify-center z-0">
        
        {/* Wave A: Slow, wide expansion */}
        <motion.div
          className="absolute rounded-full border border-white/10 bg-white/[0.02]"
          initial={{ width: "100px", height: "100px", opacity: 0 }}
          animate={{ 
            width: ["100px", "500px"], 
            height: ["100px", "500px"],
            opacity: [0.4, 0],
            borderWidth: ["1px", "0px"]
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeOut",
            delay: 0
          }}
        />

        {/* Wave B: Secondary offset wave */}
        <motion.div
          className="absolute rounded-full border border-white/5 bg-transparent"
          initial={{ width: "100px", height: "100px", opacity: 0 }}
          animate={{ 
            width: ["100px", "450px"], 
            height: ["100px", "450px"],
            opacity: [0.3, 0]
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeOut",
            delay: 4
          }}
        />

        {/* Wave C: Inner "Heartbeat" - Keeps center alive */}
        <motion.div
          className="absolute rounded-full bg-white/[0.03] blur-2xl"
          initial={{ width: "150px", height: "150px", opacity: 0 }}
          animate={{ 
            width: ["150px", "300px"], 
            height: ["150px", "300px"],
            opacity: [0.1, 0]
          }}
          transition={{
            duration: 5,
            repeat: Infinity,
            ease: "easeOut",
            delay: 2
          }}
        />
      </div>

      {/* --- LAYER 2: LOGO LAYER --- */}
      {/* Static. Charcoal. Sits above pulse. */}
      <div className="relative z-10 w-64 h-64 md:w-80 md:h-80 flex items-center justify-center">
         <img 
           src="/logo.png" 
           alt="Interloop Logo" 
           className="w-full h-full object-contain opacity-80"
           style={{ 
             filter: "brightness(0.6) contrast(1.1) grayscale(100%)", 
             mixBlendMode: "screen" /* Helps it sit nicely on black, but keeps charcoal feel */
           }} 
         />
      </div>

    </div>
  );
}

import { motion } from "framer-motion";

export function CentralForm() {
  // Pulse configuration
  // "Breath-paced", "irregular", "biological"
  // Waves originating from center, expanding outward to interact with logo ring
  
  return (
    <div className="relative flex items-center justify-center w-[500px] h-[500px] pointer-events-none">
      
      {/* The Pulse Waves */}
      {/* We layer multiple waves with different timings to create organic irregularity */}
      
      {/* Wave 1 - Deep breath */}
      <motion.div
        className="absolute rounded-full bg-white/5 blur-2xl"
        initial={{ width: "20%", height: "20%", opacity: 0 }}
        animate={{ 
          width: ["20%", "70%", "80%"], 
          height: ["20%", "70%", "80%"],
          opacity: [0, 0.15, 0] 
        }}
        transition={{
          duration: 8,
          repeat: Infinity,
          ease: "easeInOut",
          times: [0, 0.5, 1],
          delay: 0
        }}
      />

      {/* Wave 2 - Secondary rhythm */}
      <motion.div
        className="absolute rounded-full bg-white/5 blur-xl"
        initial={{ width: "10%", height: "10%", opacity: 0 }}
        animate={{ 
          width: ["10%", "60%", "70%"], 
          height: ["10%", "60%", "70%"],
          opacity: [0, 0.1, 0] 
        }}
        transition={{
          duration: 7, // Slightly off-sync for organic feel
          repeat: Infinity,
          ease: "easeOut",
          delay: 2
        }}
      />

      {/* Wave 3 - The "Heartbeat" undercurrent */}
      <motion.div
        className="absolute rounded-full bg-white/[0.03] blur-3xl"
        initial={{ width: "30%", height: "30%", opacity: 0 }}
        animate={{ 
          width: ["30%", "90%", "100%"], 
          height: ["30%", "90%", "100%"],
          opacity: [0, 0.08, 0] 
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 4
        }}
      />

      {/* The Logo - Static, centered, charcoal */}
      {/* Assuming the image provided is the circular brushstroke */}
      <div className="relative z-10 w-64 h-64 md:w-80 md:h-80 opacity-80 mix-blend-screen">
         <img 
           src="/logo.png" 
           alt="Interloop Logo" 
           className="w-full h-full object-contain opacity-60 drop-shadow-2xl"
           style={{ filter: "brightness(0.8) contrast(1.2)" }} 
         />
      </div>
    </div>
  );
}

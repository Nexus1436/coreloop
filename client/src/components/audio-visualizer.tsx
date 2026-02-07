import { useEffect, useState } from "react";
import { motion } from "framer-motion";

interface AudioVisualizerProps {
  isActive: boolean;
}

export function AudioVisualizer({ isActive }: AudioVisualizerProps) {
  // Mock data for the visualizer bars
  const bars = Array.from({ length: 12 });

  return (
    <div className="flex items-center justify-center gap-1.5 h-16" data-testid="audio-visualizer">
      {bars.map((_, index) => (
        <motion.div
          key={index}
          className="w-1.5 bg-foreground rounded-full"
          initial={{ height: 4 }}
          animate={{
            height: isActive ? [8, 32, 8] : 4,
            opacity: isActive ? 1 : 0.3,
          }}
          transition={{
            duration: 0.8,
            repeat: Infinity,
            delay: index * 0.1,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
}

export function PulseIndicator({ isActive }: { isActive: boolean }) {
  return (
    <div className="relative flex items-center justify-center w-32 h-32">
       {isActive && (
        <>
          <motion.div
            className="absolute inset-0 rounded-full bg-foreground/5"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1.5, opacity: 0 }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
          />
           <motion.div
            className="absolute inset-0 rounded-full bg-foreground/5"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1.5, opacity: 0 }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeOut", delay: 1 }}
          />
        </>
      )}
    </div>
  );
}

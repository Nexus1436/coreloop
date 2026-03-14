import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

/* =====================================================
   CENTRAL FORM

   When isSpeaking is true, getAmplitude() is called at
   ~60fps via requestAnimationFrame. The returned value
   (0.0 – 1.0) is mapped to an audioBoost that multiplies
   the smoke's scale — making it pulse with her actual voice.

   The breath cycle continues underneath as the baseline.
===================================================== */

export function CentralForm({
  isActive = false,
  isDimmed = false,
  isSpeaking = false,
  getAmplitude,
}: {
  isActive?: boolean;
  isDimmed?: boolean;
  isSpeaking?: boolean;
  getAmplitude?: () => number;
}) {
  // audioBoost: 1.0 = no boost, up to ~1.6 at peak speech amplitude
  const [audioBoost, setAudioBoost] = useState(1.0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isSpeaking || !getAmplitude) {
      // Smoothly return to baseline when not speaking
      setAudioBoost(1.0);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const tick = () => {
      const amp = getAmplitude(); // 0.0 – 1.0
      // Map amplitude to a boost multiplier: 1.0 (silence) → 1.6 (loud)
      const boost = 1.0 + amp * 0.6;
      setAudioBoost(boost);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isSpeaking, getAmplitude]);

  return (
    <div
      className="relative flex items-center justify-center w-[600px] h-[600px] pointer-events-none transition-opacity duration-1000 ease-in-out"
      style={{ opacity: isDimmed ? 0.3 : 1 }}
    >
      {/* --- LAYER 1: PULSE (BREATH) --- */}
      {/* Exists behind and through the logo. Never clipped. */}
      <div className="absolute inset-0 flex items-center justify-center z-0">
        {/* The Breath Pulse — primary layer */}
        <motion.div
          className="absolute bg-[rgba(58,58,58,1)]"
          style={{
            width: "250px",
            height: "250px",
            // audioBoost multiplies the animated scale in real time
            scale: audioBoost,
          }}
          initial={{
            scale: 0.2,
            opacity: 0.1,
            filter: "blur(4px)",
            borderRadius: "50%",
          }}
          animate={{
            scale: [0.95, 0.25, 0.25, 0.95],
            opacity: isSpeaking
              ? [0.75, 0.25, 0.25, 0.75] // brighter while speaking
              : [0.55, 0.05, 0.05, 0.55],
            filter: ["blur(45px)", "blur(25px)", "blur(25px)", "blur(45px)"],
            borderRadius: [
              "45% 55% 40% 60% / 60% 40% 55% 45%",
              "60% 40% 30% 70% / 50% 60% 30% 40%",
              "60% 40% 30% 70% / 50% 60% 30% 40%",
              "45% 55% 40% 60% / 60% 40% 55% 45%",
            ],
            rotate: [0, 90, 90, 0],
          }}
          transition={{
            duration: 12,
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.29, 0.33, 1],
          }}
        />

        {/* Secondary Diffusion Layer */}
        <motion.div
          className="absolute bg-[rgba(58,58,58,1)]"
          style={{
            width: "250px",
            height: "250px",
            scale: audioBoost,
          }}
          initial={{
            scale: 1.0,
            opacity: 0.5,
            filter: "blur(40px)",
            borderRadius: "50%",
          }}
          animate={{
            scale: [1.0, 0.3, 0.3, 1.0],
            opacity: isSpeaking
              ? [0.65, 0.08, 0.08, 0.65]
              : [0.45, 0.02, 0.02, 0.45],
            filter: ["blur(50px)", "blur(30px)", "blur(30px)", "blur(50px)"],
            borderRadius: [
              "55% 45% 60% 40% / 40% 60% 45% 55%",
              "40% 60% 70% 30% / 60% 30% 70% 40%",
              "40% 60% 70% 30% / 60% 30% 70% 40%",
              "55% 45% 60% 40% / 40% 60% 45% 55%",
            ],
            rotate: [0, -45, -45, 0],
          }}
          transition={{
            duration: 12,
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.29, 0.33, 1],
            delay: 0.1,
          }}
        />

        {/* Third Diffusion Layer */}
        <motion.div
          className="absolute bg-[rgba(58,58,58,1)]"
          style={{
            width: "250px",
            height: "250px",
            scale: audioBoost,
          }}
          initial={{
            scale: 1.0,
            opacity: 0.5,
            filter: "blur(40px)",
            borderRadius: "50%",
          }}
          animate={{
            scale: [1.0, 0.3, 0.3, 1.0],
            opacity: isSpeaking
              ? [0.65, 0.08, 0.08, 0.65]
              : [0.45, 0.02, 0.02, 0.45],
            filter: ["blur(50px)", "blur(30px)", "blur(30px)", "blur(50px)"],
            borderRadius: [
              "55% 45% 60% 40% / 40% 60% 45% 55%",
              "40% 60% 70% 30% / 60% 30% 70% 40%",
              "40% 60% 70% 30% / 60% 30% 70% 40%",
              "55% 45% 60% 40% / 40% 60% 45% 55%",
            ],
            rotate: [0, -45, -45, 0],
          }}
          transition={{
            duration: 12,
            repeat: Infinity,
            ease: "easeInOut",
            times: [0, 0.29, 0.33, 1],
            delay: 0.2,
          }}
        />
      </div>

      {/* --- FILTER DEFINITION --- */}
      <svg width="0" height="0" className="absolute">
        <filter
          id="pressed-charcoal"
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
        >
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"
            result="alphaMap"
          />
          <feGaussianBlur
            in="alphaMap"
            stdDeviation="1.5"
            result="blurredAlpha"
          />
          <feOffset
            in="blurredAlpha"
            dx="1"
            dy="2"
            result="offsetBlurredAlpha"
          />
          <feComposite
            operator="out"
            in="alphaMap"
            in2="offsetBlurredAlpha"
            result="innerShadowMask"
          />
          <feFlood flood-color="#2d2d2d" result="shadowColor" />
          <feComposite
            operator="in"
            in="shadowColor"
            in2="innerShadowMask"
            result="innerShadow"
          />
          <feFlood flood-color="#555555" result="baseColor" />
          <feComposite
            operator="in"
            in="baseColor"
            in2="alphaMap"
            result="flatBase"
          />
          <feOffset
            in="blurredAlpha"
            dx="-1"
            dy="-2"
            result="offsetHighlight"
          />
          <feComposite
            operator="out"
            in="alphaMap"
            in2="offsetHighlight"
            result="highlightMask"
          />
          <feFlood flood-color="#6a6a6a" result="highlightColor" />
          <feComposite
            operator="in"
            in="highlightColor"
            in2="highlightMask"
            result="innerHighlight"
          />
          <feMerge>
            <feMergeNode in="flatBase" />
            <feMergeNode in="innerShadow" />
            <feMergeNode in="innerHighlight" />
          </feMerge>
        </filter>
      </svg>

      {/* --- LAYER 2: LOGO (STATIC) --- */}
      <div className="relative z-10 w-64 h-64 md:w-80 md:h-80 flex items-center justify-center">
        <img
          src="/logo.png"
          alt="Interloop Logo"
          className="w-full h-full object-contain"
          style={{
            opacity: 0.88,
            filter: "url(#pressed-charcoal)",
          }}
        />
      </div>
    </div>
  );
}

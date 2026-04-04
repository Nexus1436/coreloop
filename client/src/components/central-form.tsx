import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

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
  const [audioBoost, setAudioBoost] = useState(1.0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isSpeaking || !getAmplitude) {
      setAudioBoost(1.0);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const tick = () => {
      const amp = getAmplitude();
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
      className="relative w-full h-full flex items-center justify-center pointer-events-none transition-opacity duration-1000 ease-in-out overflow-visible"
      style={{ opacity: isDimmed ? 0.3 : 1 }}
    >
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
          <feFlood floodColor="#2d2d2d" result="shadowColor" />
          <feComposite
            operator="in"
            in="shadowColor"
            in2="innerShadowMask"
            result="innerShadow"
          />
          <feFlood floodColor="#555555" result="baseColor" />
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
          <feFlood floodColor="#6a6a6a" result="highlightColor" />
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

      <div className="absolute inset-0 flex items-center justify-center z-0">
        <div className="relative w-full h-full flex items-center justify-center">
          <motion.div
            className="absolute bg-[rgba(58,58,58,1)] rounded-full"
            style={{
              width: "42%",
              height: "42%",
              scale: audioBoost,
              transformOrigin: "center center",
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
                ? [0.75, 0.25, 0.25, 0.75]
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

          <motion.div
            className="absolute bg-[rgba(58,58,58,1)] rounded-full"
            style={{
              width: "42%",
              height: "42%",
              scale: audioBoost,
              transformOrigin: "center center",
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

          <motion.div
            className="absolute bg-[rgba(58,58,58,1)] rounded-full"
            style={{
              width: "42%",
              height: "42%",
              scale: audioBoost,
              transformOrigin: "center center",
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
      </div>

      <div className="relative z-10 w-[42%] h-[42%] max-w-80 max-h-80 flex items-center justify-center">
        <div className="flex items-center justify-center w-full h-full">
          <img
            src="/logo.png"
            alt="Interloop Logo"
            className="w-full h-full object-cover object-center"
            style={{
              opacity: 0.88,
              filter: "url(#pressed-charcoal)",
            }}
          />
        </div>
      </div>
    </div>
  );
}

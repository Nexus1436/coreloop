import { useRef, useCallback, useState } from "react";

export type PlaybackState = "idle" | "playing" | "ended";

export function useAudioPlayback() {
  const [state, setState] = useState<PlaybackState>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const init = useCallback(async () => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.volume = 1.0;
      audio.onended = () => setState("ended");
      audioRef.current = audio;
    }
  }, []);

  const pushAudio = useCallback((base64Audio: string) => {
    if (!audioRef.current) return;

    const src = `data:audio/mpeg;base64,${base64Audio}`;
    audioRef.current.src = src;

    audioRef.current.play();
    setState("playing");
  }, []);

  const clear = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    setState("idle");
  }, []);

  const stop = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    setState("idle");
  }, []);

  // ✅ Add this back so Home compiles cleanly
  const signalComplete = useCallback(() => {
    // For simple HTMLAudio playback,
    // nothing required — but we expose the method
    // to keep API stable.
  }, []);

  // ✅ Voice compensation stays
  const setVoiceCompensation = useCallback((voice: string) => {
    if (!audioRef.current) return;

    if (voice === "verse") {
      audioRef.current.volume = 1.0; // male boosted
    } else if (voice === "nova") {
      audioRef.current.volume = 0.7; // female softened
    } else {
      audioRef.current.volume = 1.0;
    }
  }, []);

  return {
    state,
    init,
    pushAudio,
    signalComplete,
    clear,
    stop,
    setVoiceCompensation,
  };
}

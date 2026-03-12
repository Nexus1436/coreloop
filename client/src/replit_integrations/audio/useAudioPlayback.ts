import { useRef, useState, useCallback } from "react";

export type PlaybackState = "idle" | "playing" | "ended";

export function useAudioPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<PlaybackState>("idle");

  /* ================= INIT ================= */

  const init = useCallback(async () => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "auto";
      audio.volume = 1.0;

      audio.onplay = () => setState("playing");
      audio.onended = () => setState("ended");

      audioRef.current = audio;
    }
  }, []);

  /* ================= PLAY ================= */

  const pushAudio = useCallback(async (base64Audio: string) => {
    if (!audioRef.current) return;

    const audio = audioRef.current;

    // interrupt anything currently speaking
    audio.pause();
    audio.currentTime = 0;

    audio.src = `data:audio/mpeg;base64,${base64Audio}`;

    try {
      await audio.play();
    } catch (err) {
      console.warn("Audio play blocked:", err);
    }
  }, []);

  /* ================= STOP ================= */

  const stop = useCallback(() => {
    if (!audioRef.current) return;

    const audio = audioRef.current;

    audio.pause();
    audio.currentTime = 0;

    setState("idle");
  }, []);

  /* ================= CLEAR ================= */

  const clear = useCallback(() => {
    if (!audioRef.current) return;

    const audio = audioRef.current;

    audio.pause();
    audio.currentTime = 0;
    audio.src = "";

    setState("idle");
  }, []);

  /* ================= COMPLETE ================= */

  const signalComplete = useCallback(() => {
    setState("ended");
  }, []);

  /* ================= HELPER ================= */

  const isPlaying = state === "playing";

  return {
    state,
    isPlaying,
    init,
    pushAudio,
    stop,
    clear,
    signalComplete,
  };
}

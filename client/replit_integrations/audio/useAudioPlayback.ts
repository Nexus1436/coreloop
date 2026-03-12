import { useRef, useState, useCallback } from "react";

export type PlaybackState = "idle" | "playing" | "ended";

export function useAudioPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const playingRef = useRef(false);

  const [state, setState] = useState<PlaybackState>("idle");

  /* ================= INIT ================= */

  const init = useCallback(async () => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "auto";
      audio.volume = 1.0;

      audio.onended = () => {
        playingRef.current = false;
        playNext();
      };

      audioRef.current = audio;
    }
  }, []);

  /* ================= PLAY NEXT ================= */

  const playNext = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const next = queueRef.current.shift();

    if (!next) {
      setState("ended");
      return;
    }

    playingRef.current = true;
    setState("playing");

    audio.src = `data:audio/mpeg;base64,${next}`;

    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {});
    }
  }, []);

  /* ================= PUSH AUDIO ================= */

  const pushAudio = useCallback(
    (base64Audio: string) => {
      queueRef.current.push(base64Audio);

      // If nothing is playing, start immediately
      if (!playingRef.current) {
        playNext();
        return;
      }

      // If something is playing, preload next clip so decoding starts early
      const audio = audioRef.current;
      if (audio && queueRef.current.length === 1) {
        const preload = new Audio(
          `data:audio/mpeg;base64,${base64Audio}`
        );
        preload.preload = "auto";
      }
    },
    [playNext],
  );

  /* ================= STOP ================= */

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    queueRef.current = [];
    playingRef.current = false;

    audio.pause();
    audio.currentTime = 0;
    audio.src = "";

    setState("idle");
  }, []);

  /* ================= CLEAR ================= */

  const clear = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    queueRef.current = [];
    playingRef.current = false;

    audio.pause();
    audio.currentTime = 0;
    audio.src = "";

    setState("idle");
  }, []);

  /* ================= SIGNAL COMPLETE ================= */

  const signalComplete = useCallback(() => {
    if (!playingRef.current && queueRef.current.length === 0) {
      setState("ended");
    }
  }, []);

  return {
    state,
    init,
    pushAudio,
    stop,
    clear,
    signalComplete,
  };
}
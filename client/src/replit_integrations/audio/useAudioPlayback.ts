import { useRef, useState, useCallback } from "react";

export type PlaybackState = "idle" | "playing" | "ended";

function isValidBase64AudioChunk(value: string | null | undefined) {
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  if (!trimmed) return false;

  // reject obvious garbage / URLs
  if (trimmed.startsWith("http")) return false;
  if (trimmed.includes("replit.dev")) return false;

  // must be long enough to be real audio
  if (trimmed.length < 200) return false;

  const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;

  return base64Pattern.test(trimmed);
}

function base64ToBlob(base64: string, mimeType = "audio/mpeg") {
  const cleaned = base64.replace(/\s/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

export function useAudioPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  const queueRef = useRef<string[]>([]);
  const isPlayingRef = useRef(false);
  const stoppedRef = useRef(false);
  const completeRef = useRef(false);

  const [state, setState] = useState<PlaybackState>("idle");

  const playNextRef = useRef<(() => Promise<void>) | null>(null);

  const revokeCurrentUrl = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
  }, []);

  const resetElement = useCallback(() => {
    if (!audioRef.current) return;

    const audio = audioRef.current;
    audio.pause();
    audio.currentTime = 0;

    // DO NOT set empty src
    audio.removeAttribute("src");
  }, []);

  /* ================= INIT ================= */

  const init = useCallback(async () => {
    if (audioRef.current) return;

    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = 1.0;

    audio.onplay = () => {
      isPlayingRef.current = true;
      setState("playing");
    };

    audio.onended = () => {
      isPlayingRef.current = false;

      const playNext = playNextRef.current;
      if (playNext && queueRef.current.length > 0 && !stoppedRef.current) {
        void playNext();
        return;
      }

      setState(completeRef.current ? "ended" : "idle");
    };

    audio.onerror = () => {
      console.warn("AUDIO ERROR: bad src, skipping");

      isPlayingRef.current = false;
      revokeCurrentUrl();

      // CRITICAL: DO NOT keep broken element alive
      audioRef.current = null;

      const playNext = playNextRef.current;
      if (playNext && queueRef.current.length > 0 && !stoppedRef.current) {
        void playNext();
        return;
      }

      setState("idle");
    };

    audioRef.current = audio;
  }, [revokeCurrentUrl]);

  /* ================= PLAY NEXT ================= */

  const playNext = useCallback(async () => {
    if (isPlayingRef.current || stoppedRef.current) return;

    while (queueRef.current.length > 0) {
      const nextChunk = queueRef.current.shift();

      if (!nextChunk || !isValidBase64AudioChunk(nextChunk)) {
        console.warn("REJECTED AUDIO CHUNK:", String(nextChunk).slice(0, 120));
        continue;
      }

      try {
        const blob = base64ToBlob(nextChunk);

        if (!blob.size) continue;

        // re-init audio if previous failed
        if (!audioRef.current) {
          await init();
        }

        const audio = audioRef.current;
        if (!audio) return;

        resetElement();
        revokeCurrentUrl();

        const url = URL.createObjectURL(blob);
        currentUrlRef.current = url;

        audio.src = url;

        await audio.play();
        return;
      } catch (err) {
        console.warn("Audio chunk rejected:", err);
        revokeCurrentUrl();
      }
    }

    setState(completeRef.current ? "ended" : "idle");
  }, [init, resetElement, revokeCurrentUrl]);

  playNextRef.current = playNext;

  /* ================= PUSH ================= */

  const pushAudio = useCallback(
    async (base64Audio: string) => {
      if (!isValidBase64AudioChunk(base64Audio)) {
        console.warn(
          "REJECTED AUDIO CHUNK:",
          String(base64Audio).slice(0, 120),
        );
        return;
      }

      stoppedRef.current = false;
      completeRef.current = false;

      queueRef.current.push(base64Audio);

      if (!isPlayingRef.current) {
        await playNext();
      }
    },
    [playNext],
  );

  /* ================= STOP ================= */

  const stop = useCallback(() => {
    stoppedRef.current = true;
    completeRef.current = false;
    queueRef.current = [];
    isPlayingRef.current = false;

    resetElement();
    revokeCurrentUrl();

    setState("idle");
  }, [resetElement, revokeCurrentUrl]);

  /* ================= CLEAR ================= */

  const clear = useCallback(() => {
    stoppedRef.current = true;
    completeRef.current = false;
    queueRef.current = [];
    isPlayingRef.current = false;

    resetElement();
    revokeCurrentUrl();

    setState("idle");
  }, [resetElement, revokeCurrentUrl]);

  /* ================= COMPLETE ================= */

  const signalComplete = useCallback(() => {
    completeRef.current = true;

    if (!isPlayingRef.current && queueRef.current.length === 0) {
      setState("ended");
    }
  }, []);

  /* ================= HELPER ================= */

  const getAmplitude = useCallback(() => 0, []);

  const isPlaying = state === "playing";

  return {
    state,
    isPlaying,
    init,
    pushAudio,
    stop,
    clear,
    signalComplete,
    getAmplitude,
  };
}

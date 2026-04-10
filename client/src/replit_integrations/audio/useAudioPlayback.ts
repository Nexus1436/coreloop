// useAudioPlayback.ts
import { useRef, useState, useCallback } from "react";

export type PlaybackState = "idle" | "playing" | "ended";

function isValidBase64AudioChunk(value: string | null | undefined) {
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith("http")) return false;
  if (trimmed.includes("replit.dev")) return false;
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
  const isStartingRef = useRef(false);
  const stoppedRef = useRef(true);
  const completeRef = useRef(false);

  const sessionRef = useRef(0);
  const activeSessionRef = useRef(0);
  const playRequestRef = useRef(0);

  const [state, setState] = useState<PlaybackState>("idle");

  const playNextRef = useRef<(() => Promise<void>) | null>(null);

  const revokeCurrentUrl = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
  }, []);

  const resetElement = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    try {
      audio.pause();
    } catch {}

    try {
      audio.currentTime = 0;
    } catch {}

    try {
      audio.removeAttribute("src");
      audio.load();
    } catch {}
  }, []);

  const invalidatePlayback = useCallback(() => {
    sessionRef.current += 1;
    activeSessionRef.current = 0;
    playRequestRef.current += 1;
  }, []);

  const init = useCallback(async () => {
    if (audioRef.current) return;

    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = 1.0;
    audio.setAttribute("playsinline", "true");

    audio.onplay = () => {
      if (activeSessionRef.current !== sessionRef.current) {
        try {
          audio.pause();
        } catch {}
        return;
      }

      isPlayingRef.current = true;
      isStartingRef.current = false;
      setState("playing");
    };

    audio.onended = () => {
      if (activeSessionRef.current !== sessionRef.current) return;

      isPlayingRef.current = false;
      isStartingRef.current = false;

      resetElement();
      revokeCurrentUrl();
      activeSessionRef.current = 0;

      if (stoppedRef.current) {
        setState("idle");
        return;
      }

      const playNext = playNextRef.current;
      if (playNext && queueRef.current.length > 0) {
        void playNext();
        return;
      }

      setState(completeRef.current ? "ended" : "idle");
    };

    audio.onerror = () => {
      if (activeSessionRef.current !== sessionRef.current) return;

      isPlayingRef.current = false;
      isStartingRef.current = false;

      resetElement();
      revokeCurrentUrl();
      activeSessionRef.current = 0;

      setState("idle");
    };

    audioRef.current = audio;
  }, [resetElement, revokeCurrentUrl]);

  const hardReset = useCallback(
    (markStopped: boolean) => {
      invalidatePlayback();

      stoppedRef.current = markStopped;
      completeRef.current = false;
      queueRef.current = [];
      isPlayingRef.current = false;
      isStartingRef.current = false;

      resetElement();
      revokeCurrentUrl();

      setState("idle");
    },
    [invalidatePlayback, resetElement, revokeCurrentUrl],
  );

  const playNext = useCallback(async () => {
    if (stoppedRef.current || isPlayingRef.current || isStartingRef.current) {
      return;
    }

    await init();

    const audio = audioRef.current;
    if (!audio) {
      setState("idle");
      return;
    }

    const requestId = playRequestRef.current;

    while (queueRef.current.length > 0) {
      if (stoppedRef.current || requestId !== playRequestRef.current) {
        setState("idle");
        return;
      }

      const chunk = queueRef.current.shift();

      if (!chunk || !isValidBase64AudioChunk(chunk)) continue;

      try {
        const blob = base64ToBlob(chunk);
        if (!blob.size) continue;

        const sessionId = sessionRef.current;

        resetElement();
        revokeCurrentUrl();
        activeSessionRef.current = 0;

        const url = URL.createObjectURL(blob);
        currentUrlRef.current = url;
        activeSessionRef.current = sessionId;

        audio.src = url;
        audio.load();

        isStartingRef.current = true;

        try {
          await audio.play();
        } catch {
          if (sessionId === sessionRef.current) {
            hardReset(true);
          }
          return;
        }

        if (
          requestId !== playRequestRef.current ||
          sessionId !== sessionRef.current ||
          stoppedRef.current
        ) {
          isStartingRef.current = false;
          isPlayingRef.current = false;
          resetElement();
          revokeCurrentUrl();
          activeSessionRef.current = 0;
          continue;
        }

        return;
      } catch {
        isStartingRef.current = false;
        isPlayingRef.current = false;
        resetElement();
        revokeCurrentUrl();
        activeSessionRef.current = 0;
      }
    }

    setState("idle");
  }, [init, resetElement, revokeCurrentUrl, hardReset]);

  playNextRef.current = playNext;

  const pushAudio = useCallback(
    async (base64Audio: string) => {
      if (!isValidBase64AudioChunk(base64Audio)) return;

      await init();

      if (stoppedRef.current) {
        hardReset(false);
      }

      stoppedRef.current = false;
      completeRef.current = false;

      queueRef.current.push(base64Audio);

      if (!isPlayingRef.current && !isStartingRef.current) {
        await playNext();
      }
    },
    [init, playNext, hardReset],
  );

  const replaceAndPlay = useCallback(
    async (base64Audio: string) => {
      if (!isValidBase64AudioChunk(base64Audio)) return;

      await init();

      hardReset(false);

      stoppedRef.current = false;
      completeRef.current = false;
      queueRef.current = [base64Audio];

      await playNext();
    },
    [init, playNext, hardReset],
  );

  const stop = useCallback(() => {
    hardReset(true);
  }, [hardReset]);

  const clear = useCallback(() => {
    hardReset(true);
  }, [hardReset]);

  const signalComplete = useCallback(() => {
    completeRef.current = true;

    if (
      !isPlayingRef.current &&
      !isStartingRef.current &&
      queueRef.current.length === 0
    ) {
      setState("ended");
    }
  }, []);

  const getAmplitude = useCallback(() => 0, []);

  const isPlaying = state === "playing";

  return {
    state,
    isPlaying,
    init,
    pushAudio,
    replaceAndPlay,
    stop,
    clear,
    signalComplete,
    getAmplitude,
  };
}

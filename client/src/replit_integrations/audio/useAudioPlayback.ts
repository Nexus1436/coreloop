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
  const activePlaySessionRef = useRef(0);
  const hasStartedCurrentSessionRef = useRef(false);

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

  const init = useCallback(async () => {
    if (audioRef.current) return;

    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = 1.0;
    audio.playsInline = true;

    audio.onplay = () => {
      if (activePlaySessionRef.current !== sessionRef.current) return;

      isPlayingRef.current = true;
      isStartingRef.current = false;
      setState("playing");
    };

    audio.onended = () => {
      if (activePlaySessionRef.current !== sessionRef.current) return;

      isPlayingRef.current = false;
      isStartingRef.current = false;

      resetElement();
      revokeCurrentUrl();

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
      if (activePlaySessionRef.current !== sessionRef.current) return;

      isPlayingRef.current = false;
      isStartingRef.current = false;

      resetElement();
      revokeCurrentUrl();

      const playNext = playNextRef.current;
      if (playNext && queueRef.current.length > 0 && !stoppedRef.current) {
        void playNext();
        return;
      }

      setState(completeRef.current ? "ended" : "idle");
    };

    audioRef.current = audio;
  }, [resetElement, revokeCurrentUrl]);

  const hardResetPlayback = useCallback(
    (markStopped: boolean) => {
      sessionRef.current += 1;
      activePlaySessionRef.current = 0;
      hasStartedCurrentSessionRef.current = false;

      stoppedRef.current = markStopped;
      completeRef.current = false;
      queueRef.current = [];
      isPlayingRef.current = false;
      isStartingRef.current = false;

      resetElement();
      revokeCurrentUrl();

      setState("idle");
    },
    [resetElement, revokeCurrentUrl],
  );

  const beginFreshPlaybackSession = useCallback(async () => {
    await init();
    hardResetPlayback(false);
  }, [hardResetPlayback, init]);

  const playNext = useCallback(async () => {
    if (stoppedRef.current || isPlayingRef.current || isStartingRef.current) {
      return;
    }

    await init();

    const audio = audioRef.current;
    if (!audio) {
      setState(completeRef.current ? "ended" : "idle");
      return;
    }

    while (queueRef.current.length > 0) {
      if (stoppedRef.current) {
        setState("idle");
        return;
      }

      const nextChunk = queueRef.current.shift();

      if (!nextChunk || !isValidBase64AudioChunk(nextChunk)) {
        console.warn("REJECTED AUDIO CHUNK:", String(nextChunk).slice(0, 120));
        continue;
      }

      try {
        const blob = base64ToBlob(nextChunk);

        if (!blob.size) {
          console.warn("REJECTED AUDIO CHUNK: empty blob");
          continue;
        }

        const sessionId = sessionRef.current;

        resetElement();
        revokeCurrentUrl();

        const url = URL.createObjectURL(blob);
        currentUrlRef.current = url;
        activePlaySessionRef.current = sessionId;

        audio.src = url;
        audio.load();

        if (stoppedRef.current || sessionId !== sessionRef.current) {
          resetElement();
          revokeCurrentUrl();
          continue;
        }

        isStartingRef.current = true;
        await audio.play();

        if (stoppedRef.current || sessionId !== sessionRef.current) {
          isStartingRef.current = false;
          isPlayingRef.current = false;
          resetElement();
          revokeCurrentUrl();
          continue;
        }

        return;
      } catch (err) {
        console.warn("Audio chunk rejected:", err);
        isStartingRef.current = false;
        isPlayingRef.current = false;
        resetElement();
        revokeCurrentUrl();
      }
    }

    setState(completeRef.current ? "ended" : "idle");
  }, [init, resetElement, revokeCurrentUrl]);

  playNextRef.current = playNext;

  const pushAudio = useCallback(
    async (base64Audio: string) => {
      if (!isValidBase64AudioChunk(base64Audio)) {
        console.warn(
          "REJECTED AUDIO CHUNK:",
          String(base64Audio).slice(0, 120),
        );
        return;
      }

      await init();

      if (stoppedRef.current || !hasStartedCurrentSessionRef.current) {
        await beginFreshPlaybackSession();
        hasStartedCurrentSessionRef.current = true;
      }

      stoppedRef.current = false;
      completeRef.current = false;

      queueRef.current.push(base64Audio);

      if (!isPlayingRef.current && !isStartingRef.current) {
        await playNext();
      }
    },
    [beginFreshPlaybackSession, init, playNext],
  );

  const stop = useCallback(() => {
    hardResetPlayback(true);
  }, [hardResetPlayback]);

  const clear = useCallback(() => {
    hardResetPlayback(true);
  }, [hardResetPlayback]);

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
    stop,
    clear,
    signalComplete,
    getAmplitude,
  };
}

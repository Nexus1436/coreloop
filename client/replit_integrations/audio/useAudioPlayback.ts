import { useRef, useState, useCallback, useEffect } from "react";

export type PlaybackState = "idle" | "playing" | "ended";

export function useAudioPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  const streamCompleteRef = useRef(false);

  const [state, setState] = useState<PlaybackState>("idle");

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceConnectedRef = useRef(false);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  /* ================= CHECK IF DONE ================= */
  const checkIfDone = useCallback(() => {
    if (
      streamCompleteRef.current &&
      !playingRef.current &&
      queueRef.current.length === 0
    ) {
      setState("ended");
    }
  }, []);

  /* ================= PLAY NEXT ================= */
  const playNextRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const playNext = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    const next = queueRef.current.shift();

    if (!next) {
      playingRef.current = false;
      checkIfDone();
      return;
    }

    if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
      try {
        await audioCtxRef.current.resume();
      } catch (e) {
        console.error("AudioContext resume failed:", e);
      }
    }

    playingRef.current = true;
    setState("playing");

    audio.onended = () => {
      playingRef.current = false;
      playNextRef.current?.();
    };

    audio.onerror = () => {
      console.error("AUDIO ERROR:", audio.error);
      console.error("BAD SRC SAMPLE:", audio.src?.slice(0, 80));
      playingRef.current = false;
      checkIfDone();
    };

    audio.src = `data:audio/mpeg;base64,${next}`;

    try {
      await audio.play();
      console.log("audio.play() SUCCESS");
    } catch (err) {
      console.error("audio.play() FAILED:", err);
      playingRef.current = false;
      checkIfDone();
    }
  }, [checkIfDone]);

  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  /* ================= INIT ================= */
  const init = useCallback(async () => {
    // MUST be called from user gesture (tap)

    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "auto";
      audio.volume = 1.0;
      audioRef.current = audio;
    }

    if (!audioCtxRef.current) {
      const ctx = new AudioContext();

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;

      const bufferLength = analyser.frequencyBinCount;
      dataArrayRef.current = new Uint8Array(bufferLength);

      analyser.connect(ctx.destination);

      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
    }

    if (
      audioRef.current &&
      audioCtxRef.current &&
      !sourceConnectedRef.current
    ) {
      try {
        const source = audioCtxRef.current.createMediaElementSource(
          audioRef.current,
        );
        source.connect(analyserRef.current!);
        sourceConnectedRef.current = true;
      } catch {}
    }

    if (audioCtxRef.current.state === "suspended") {
      try {
        await audioCtxRef.current.resume();
      } catch (e) {
        console.error("AudioContext resume failed:", e);
      }
    }
  }, []);

  /* ❌ CRITICAL FIX: REMOVE AUTO INIT */
  // DO NOT auto-init on mount
  // useEffect(() => {
  //   init();
  // }, [init]);

  /* ================= GET AMPLITUDE ================= */
  const getAmplitude = useCallback((): number => {
    const analyser = analyserRef.current;
    const dataArray = dataArrayRef.current;
    if (!analyser || !dataArray) return 0;

    analyser.getByteFrequencyData(dataArray);

    const slice = Math.floor(dataArray.length / 2);
    let sum = 0;

    for (let i = 0; i < slice; i++) {
      sum += dataArray[i];
    }

    return sum / (slice * 255);
  }, []);

  /* ================= PUSH AUDIO ================= */
  const pushAudio = useCallback(
    async (base64Audio: string) => {
      if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
        try {
          await audioCtxRef.current.resume();
        } catch {}
      }

      queueRef.current.push(base64Audio);

      if (!playingRef.current) {
        playNext();
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
    streamCompleteRef.current = false;

    audio.onended = null;
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
    streamCompleteRef.current = false;

    audio.onended = null;
    audio.pause();
    audio.currentTime = 0;
    audio.src = "";

    setState("idle");
  }, []);

  /* ================= SIGNAL COMPLETE ================= */
  const signalComplete = useCallback(() => {
    streamCompleteRef.current = true;
    checkIfDone();
  }, [checkIfDone]);

  return {
    state,
    init,
    pushAudio,
    stop,
    clear,
    signalComplete,
    getAmplitude,
  };
}

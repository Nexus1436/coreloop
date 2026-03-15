import { useRef, useState, useCallback, useEffect } from "react";

export type PlaybackState = "idle" | "playing" | "ended";

export function useAudioPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const queueRef = useRef<string[]>([]);
  const playingRef = useRef(false);
  const [state, setState] = useState<PlaybackState>("idle");

  // Web Audio API refs for real-time amplitude
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceConnectedRef = useRef(false);
  const dataArrayRef = useRef<Uint8Array | null>(null);

  /* ================= INIT ================= */
  const init = useCallback(async () => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "auto";
      audio.volume = 1.0;
      audio.crossOrigin = "anonymous";
      audio.onended = () => {
        playingRef.current = false;
        playNext();
      };
      audioRef.current = audio;
    }

    // Set up Web Audio analyser once
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

    // Connect audio element to analyser (once)
    if (
      audioRef.current &&
      audioCtxRef.current &&
      !sourceConnectedRef.current
    ) {
      const source = audioCtxRef.current.createMediaElementSource(
        audioRef.current,
      );
      source.connect(analyserRef.current!);
      sourceConnectedRef.current = true;
    }

    // Resume context if browser suspended it
    if (audioCtxRef.current?.state === "suspended") {
      await audioCtxRef.current.resume();
    }
  }, []);

  /* ================= AUTO INIT ================= */
  useEffect(() => {
    init();
  }, [init]);

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

      if (!playingRef.current) {
        playNext();
        return;
      }

      const audio = audioRef.current;

      if (audio && queueRef.current.length === 1) {
        const preload = new Audio(`data:audio/mpeg;base64,${base64Audio}`);
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
    getAmplitude,
  };
}

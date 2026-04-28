/**
 * React hook for voice recording using a native Capacitor voice recorder.
 */
import { VoiceRecorder, RecordingStatus } from "capacitor-voice-recorder";
import { useCallback, useRef, useState } from "react";

export type RecordingState = "idle" | "recording" | "stopped";

function logBase64Stage(stage: string, value: string, mimeType: string) {
  console.log("voice recorder stage:", {
    stage,
    length: value.length,
    first20: value.slice(0, 20),
    last20: value.slice(-20),
    mod4: value.length % 4,
    mimeType,
  });
}

function logVoiceError(stage: string, error: unknown) {
  console.error("voice recorder error:", {
    stage,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  logBase64Stage("base64ToBlob:input", base64, mimeType);

  let clean: string;
  try {
    clean = base64.includes(",") ? base64.split(",")[1] : base64;
    logBase64Stage("base64ToBlob:prefix-stripped", clean, mimeType);
  } catch (error) {
    logVoiceError("base64ToBlob:prefix-strip", error);
    throw error;
  }

  let slashNormalized: string;
  try {
    slashNormalized = clean.replace(/\\\//g, "/");
    logBase64Stage("base64ToBlob:slash-normalized", slashNormalized, mimeType);
  } catch (error) {
    logVoiceError("base64ToBlob:slash-normalize", error);
    throw error;
  }

  let normalized: string;
  try {
    normalized = slashNormalized.replace(/\s/g, "");
    logBase64Stage("base64ToBlob:whitespace-removed", normalized, mimeType);
  } catch (error) {
    logVoiceError("base64ToBlob:whitespace-remove", error);
    throw error;
  }

  let padded: string;
  try {
    const paddingNeeded = normalized.length % 4;
    padded =
      paddingNeeded > 0
        ? normalized + "=".repeat(4 - paddingNeeded)
        : normalized;
    logBase64Stage("base64ToBlob:padded", padded, mimeType);
  } catch (error) {
    logVoiceError("base64ToBlob:padding", error);
    throw error;
  }

  const sliceSize = 1024;
  const byteArrays = [];

  try {
    for (let offset = 0; offset < padded.length; offset += sliceSize) {
      const slice = padded.slice(offset, offset + sliceSize);

      const binary = atob(slice);
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      byteArrays.push(bytes);
    }
  } catch (error) {
    logVoiceError("base64ToBlob:chunk-decode", error);
    throw error;
  }

  try {
    const blob = new Blob(byteArrays, { type: mimeType });
    console.log("voice recorder stage:", {
      stage: "base64ToBlob:blob-constructed",
      size: blob.size,
      type: blob.type,
    });
    return blob;
  } catch (error) {
    logVoiceError("base64ToBlob:blob-construction", error);
    throw error;
  }
}

async function ensureMicrophonePermission(): Promise<void> {
  const existing = await VoiceRecorder.hasAudioRecordingPermission();

  if (existing.value) {
    return;
  }

  const requested = await VoiceRecorder.requestAudioRecordingPermission();

  if (!requested.value) {
    throw new Error("Microphone permission denied");
  }
}

export function useVoiceRecorder() {
  const [state, setState] = useState<RecordingState>("idle");
  const isRecordingRef = useRef(false);

  const startRecording = useCallback(async (): Promise<void> => {
    await ensureMicrophonePermission();

    const status = await VoiceRecorder.getCurrentStatus();

    if (status.status === RecordingStatus.RECORDING) {
      isRecordingRef.current = true;
      setState("recording");
      return;
    }

    await VoiceRecorder.startRecording();

    isRecordingRef.current = true;
    setState("recording");
  }, []);

  const stopRecording = useCallback(async (): Promise<Blob> => {
    if (!isRecordingRef.current) {
      return new Blob();
    }

    const result = await VoiceRecorder.stopRecording();
    console.log("voice recorder stage:", {
      stage: "stopRecording:result",
      hasValue: Boolean(result.value),
      hasRecordDataBase64: Boolean(result.value.recordDataBase64),
      mimeType: result.value.mimeType,
    });

    const base64 = result.value.recordDataBase64;

    if (!base64) {
      throw new Error("Recorder did not return audio data");
    }

    const mimeType = result.value.mimeType || "audio/aac";
    const blob = base64ToBlob(base64, mimeType);

    isRecordingRef.current = false;
    setState("stopped");

    console.log("voice recorder stage:", {
      stage: "stopRecording:return",
      blobSize: blob.size,
      blobType: blob.type,
    });

    return blob;
  }, []);

  return { state, startRecording, stopRecording };
}

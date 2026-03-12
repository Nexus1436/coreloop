/**
 * React hook for handling SSE voice streaming responses.
 * Converts audio blob to base64 and sends as JSON to match server expectations.
 */

import { useCallback } from "react";
import { useAudioPlayback } from "./useAudioPlayback";

interface StreamCallbacks {
  onUserTranscript?: (text: string) => void;
  onTranscript?: (text: string, full: string) => void;
  onComplete?: (transcript: string) => void;
  onError?: (error: Error) => void;
}

export function useVoiceStream(callbacks: StreamCallbacks = {}) {
  const playback = useAudioPlayback();

  const streamVoiceResponse = useCallback(
    async (url: string, audioBlob: Blob) => {
      try {
        // Ensure playback system ready
        await playback.init();
        playback.stop();
        playback.clear();

        // Convert blob → base64
        const base64Audio = await new Promise<string>((resolve) => {
          const fileReader = new FileReader();

          fileReader.onload = () => {
            const result = fileReader.result as string;
            resolve(result.split(",")[1]);
          };

          fileReader.readAsDataURL(audioBlob);
        });

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64Audio }),
        });

        if (!response.ok) throw new Error("Voice request failed");

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();

        let buffer = "";
        let fullTranscript = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            try {
              const event = JSON.parse(line.slice(6));

              switch (event.type) {
                case "user_transcript":
                  callbacks.onUserTranscript?.(event.data);
                  break;

                case "transcript":
                  fullTranscript += event.data;
                  callbacks.onTranscript?.(event.data, fullTranscript);
                  break;

                case "audio":
                  playback.pushAudio(event.data);
                  break;

                case "done":
                  playback.signalComplete();
                  callbacks.onComplete?.(fullTranscript);
                  break;

                case "error":
                  throw new Error(event.error);
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) {
                callbacks.onError?.(e as Error);
              }
            }
          }
        }
      } catch (err) {
        callbacks.onError?.(err as Error);
      }
    },
    [playback, callbacks],
  );

  return {
    streamVoiceResponse,
    playbackState: playback.state,
  };
}

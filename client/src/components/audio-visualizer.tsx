import { useRef, useState } from "react";

export default function AudioVisualizer() {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const [recording, setRecording] = useState(false);

  async function startRecording() {
    console.log("🎤 Mic tapped");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.log("✅ Mic permission granted");

    const mediaRecorder = new MediaRecorder(stream);
    mediaRecorderRef.current = mediaRecorder;
    chunksRef.current = [];

    mediaRecorder.ondataavailable = (e) => {
      chunksRef.current.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      console.log("📦 Audio blob size:", blob.size);

      if (blob.size === 0) {
        console.error("❌ Empty audio blob");
        return;
      }

      const formData = new FormData();
      formData.append("audio", blob); // MUST be "audio"

      const res = await fetch("/chat/speech-to-text", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      console.log("📝 Transcription result:", data);
    };

    mediaRecorder.start();
    setRecording(true);
    console.log("🔴 Recording started");
  }

  function stopRecording() {
    if (!mediaRecorderRef.current) return;

    mediaRecorderRef.current.stop();
    setRecording(false);
    console.log("⏹️ Recording stopped");
  }

  return (
    <button
      onClick={recording ? stopRecording : startRecording}
      style={{
        background: "none",
        border: "none",
        color: "#aaa",
        fontSize: "18px",
        cursor: "pointer",
      }}
    >
      {recording ? "Stop Mic" : "Start Mic"}
    </button>
  );
}
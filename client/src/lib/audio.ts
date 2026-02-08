export async function speechToText(audioBlob: Blob) {
  const formData = new FormData();
  formData.append("audio", audioBlob);

  const res = await fetch("/chat/speech-to-text", {
    method: "POST",
    body: formData,
  });

  return res.json();
}

export async function textToSpeech(text: string) {
  const res = await fetch("/chat/text-to-speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  const audioBlob = await res.blob();
  return URL.createObjectURL(audioBlob);
}
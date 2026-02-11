import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

async function test() {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: "Say ONLY the word: connected",
      },
    ],
  });

  console.log("OPENAI RESPONSE:");
  console.log(response.choices[0].message.content);
}

test().catch(console.error);


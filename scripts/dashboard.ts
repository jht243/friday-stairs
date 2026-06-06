import "dotenv/config";
import OpenAI from "openai";
import { createServer } from "../src/server.js";

const PORT = Number(process.env.PORT ?? 3000);

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required. Copy .env.example to .env and add your key.");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = createServer(client);

app.listen(PORT, () => {
  console.log(`🪜 Friday Stairs dashboard → http://localhost:${PORT}`);
});

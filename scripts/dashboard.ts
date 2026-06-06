import "dotenv/config";
import OpenAI from "openai";
import { createServer } from "../src/server.js";

const PORT = Number(process.env.PORT ?? 3000);

if (!process.env.OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is not set. The dashboard will boot, but AI generation endpoints require a valid key.");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "missing-openai-api-key" });
const app = createServer(client);

app.listen(PORT, () => {
  console.log(`🪜 Friday Stairs dashboard → http://localhost:${PORT}`);
});

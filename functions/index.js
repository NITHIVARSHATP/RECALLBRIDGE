const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const cors = require("cors")({ origin: true });
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Limit concurrency to control cost + stability
setGlobalOptions({ maxInstances: 10 });

// Initialize Gemini (API key comes from Firebase env config)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * RecallBridge – Panic Safe Cue Generator
 * POST /generatePanicCues
 */
exports.generatePanicCues = onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
      }

      const { text } = req.body;

      if (!text || text.trim().length < 20) {
        return res.status(400).json({
          error: "Input text too short for recall generation",
        });
      }

      const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
      });

      const prompt = `
You are an AI system designed for PANIC-SAFE academic recall.

The user already knows this content but is under stress.
DO NOT explain or teach.

TASK:
1. Generate exactly 5 ultra-short recall cues (max 8 words each)
2. Generate 1 fallback recall chain:
   "If blank → remember X → leads to Y → leads to Z"
3. Mention 1 common panic mistake to avoid

RULES:
- Minimal words
- No markdown
- Plain text only

CONTENT:
${text}
`;

      const result = await model.generateContent(prompt);
      const output = result.response.text();

      return res.status(200).json({ cues: output });
    } catch (error) {
      console.error("Gemini error:", error);
      return res.status(500).json({
        error: "Failed to generate panic-safe cues",
      });
    }
  });
});

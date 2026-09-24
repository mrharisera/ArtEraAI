import { InferenceClient } from "@huggingface/inference";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt, style = "Realistic", ratio = "1:1" } = req.body || {};

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const token = process.env.HF_TOKEN;

    if (!token) {
      return res.status(500).json({ error: "HF_TOKEN is not configured" });
    }

    const sizes = {
      "1:1": [1024, 1024],
      "16:9": [1344, 768],
      "9:16": [768, 1344],
      "4:5": [1024, 1280]
    };

    const [width, height] = sizes[ratio] || sizes["1:1"];

    const fullPrompt =
      `${prompt}. Visual style: ${style}. High quality, detailed, polished artwork.`;

    const client = new InferenceClient(token);

    const imageBlob = await client.textToImage({
      model: "black-forest-labs/FLUX.1-schnell",
      inputs: fullPrompt,
      parameters: {
        width,
        height
      }
    });

    const contentType = imageBlob.type || "image/png";
    const base64 = Buffer.from(
      await imageBlob.arrayBuffer()
    ).toString("base64");

    return res.status(200).json({
      image: `data:${contentType};base64,${base64}`
    });

  } catch (e) {
    return res.status(500).json({
      error: e?.message || "Image generation failed"
    });
  }
}

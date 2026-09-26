import { InferenceClient } from "@huggingface/inference";

const client = new InferenceClient(process.env.HF_TOKEN);

const styleHint = (style) => ({
  "Realistic": "photorealistic, natural textures, realistic lighting",
  "Cinematic": "cinematic film lighting, dramatic depth, cinematic composition",
  "Premium Poster": "premium commercial poster, polished composition, professional graphic design",
  "3D Render": "high-end 3D render, detailed materials, realistic reflections",
  "Digital Art": "high-detail digital artwork, polished professional finish",
  "Anime": "high-quality anime illustration, detailed character art"
}[style] || style);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  if (!process.env.HF_TOKEN) {
    return res.status(500).json({
      error: "HF_TOKEN is not configured."
    });
  }

  try {
    const {
      prompt,
      style = "Realistic",
      ratio = "1:1",
      count = 1,
      strength = 60,
      reference
    } = req.body || {};

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({
        error: "Prompt is required."
      });
    }

    const imageCount = Math.min(
      Math.max(Number(count) || 1, 1),
      4
    );

    const finalPrompt =
      `${prompt.trim()}. ` +
      `${styleHint(style)}. ` +
      `Composition ratio ${ratio}. ` +
      `High quality, sharp details, professional visual composition.`;

    const images = [];

    for (let i = 0; i < imageCount; i++) {
      let generatedImage = null;

      // Reference image generation
      if (
        reference &&
        typeof reference === "string" &&
        reference.startsWith("data:image/")
      ) {
        try {
          const base64Data = reference.split(",")[1];

          const mimeType =
            reference.match(/^data:(image\/[^;]+);/)?.[1] ||
            "image/png";

          const imageBuffer = Buffer.from(
            base64Data,
            "base64"
          );

          generatedImage = await client.imageToImage({
            model: "black-forest-labs/FLUX.2-klein-9B",
            inputs: new Blob(
              [imageBuffer],
              { type: mimeType }
            ),
            parameters: {
              prompt: finalPrompt,
              strength: Math.min(
                Math.max(Number(strength) / 100, 0.05),
                0.95
              )
            }
          });
        } catch (referenceError) {
          console.error(
            "Reference generation failed:",
            referenceError
          );
        }
      }

      // Normal text-to-image generation
      if (!generatedImage) {
        generatedImage = await client.textToImage({
          provider: "auto",
          model: "black-forest-labs/FLUX.1-schnell",
          inputs: finalPrompt
        });
      }

      const arrayBuffer =
        await generatedImage.arrayBuffer();

      const base64Image =
        Buffer.from(arrayBuffer).toString("base64");

      images.push(
        `data:${generatedImage.type || "image/png"};base64,${base64Image}`
      );
    }

    return res.status(200).json({
      images
    });

  } catch (error) {
    console.error("Generation error:", error);

    return res.status(500).json({
      error:
        error?.message ||
        "Image generation failed."
    });
  }
}

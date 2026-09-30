import { InferenceClient } from "@huggingface/inference";

const client = new InferenceClient(process.env.HF_TOKEN);

const styleHint = (style) => ({
  "Realistic":
    "photorealistic, natural textures, realistic lighting",
  "Cinematic":
    "cinematic film lighting, dramatic depth, cinematic composition",
  "Premium Poster":
    "premium commercial poster, polished composition",
  "3D Render":
    "high-end 3D render, detailed materials, realistic reflections",
  "Digital Art":
    "high-detail digital artwork, polished professional finish",
  "Anime":
    "high-quality anime illustration, detailed character art"
}[style] || style);

const clamp = (value, min, max) =>
  Math.min(Math.max(Number(value) || 0, min), max);

const toBlob = (data) => {
  const match = String(data || "").match(
    /^data:(image\/[^;]+);base64,(.+)$/
  );

  if (!match) {
    throw new Error("Invalid reference image.");
  }

  return new Blob(
    [Buffer.from(match[2], "base64")],
    { type: match[1] }
  );
};

const dataUrl = async (blob) => {
  const buffer = Buffer.from(
    await blob.arrayBuffer()
  );

  return `data:${blob.type || "image/png"};base64,${buffer.toString("base64")}`;
};

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
      operation = "generate",
      prompt = "",
      style = "Realistic",
      ratio = "1:1",
      count = 1,
      strength = 60,
      reference
    } = req.body || {};

    /* =========================
       REMOVE BACKGROUND
    ========================= */

    if (operation === "remove") {

      if (!reference?.startsWith("data:image/")) {
        return res.status(400).json({
          error:
            "An image is required for background removal."
        });
      }

      const segments =
        await client.imageSegmentation({
          model: "briaai/RMBG-2.0",
          inputs: toBlob(reference)
        });

      const best = segments
        .filter(item => item?.mask)
        .sort(
          (a, b) =>
            (b.score || 0) -
            (a.score || 0)
        )[0];

      if (!best?.mask) {
        return res.status(500).json({
          error:
            "Background mask could not be created."
        });
      }

      let maskData = best.mask;

      if (
        typeof maskData === "string" &&
        !maskData.startsWith("data:")
      ) {
        maskData =
          `data:image/png;base64,${maskData}`;
      }

      return res.status(200).json({
        mask: maskData
      });
    }

    /* =========================
       IMAGE COUNT
    ========================= */

    const imageCount =
      operation === "variations"
        ? 4
        : Math.min(
            Math.max(Number(count) || 1, 1),
            4
          );

    /* =========================
       PROMPT VALIDATION
    ========================= */

    if (
      !prompt &&
      operation !== "variations" &&
      operation !== "remove"
    ) {
      return res.status(400).json({
        error: "Prompt is required."
      });
    }

    /* =========================
       REFERENCE VALIDATION
    ========================= */

    if (
      ["edit", "background", "variations"]
        .includes(operation) &&
      !reference?.startsWith("data:image/")
    ) {
      return res.status(400).json({
        error:
          "Please select or upload an image first."
      });
    }

    const images = [];

    /* =========================
       GENERATION LOOP
    ========================= */

    for (let i = 0; i < imageCount; i++) {

      let generatedImage = null;

      /* =========================
         IMAGE-TO-IMAGE OPERATIONS
      ========================= */

      if (
        reference?.startsWith("data:image/")
      ) {

        let finalPrompt = "";

        if (operation === "background") {

          finalPrompt =
            `Preserve the main subject and replace ONLY the background. ` +
            `New background: ${prompt}. ` +
            `Keep the subject natural, sharp, correctly lit, ` +
            `and professionally integrated.`;

        } else if (operation === "edit") {

          finalPrompt =
            `Edit the provided image according to this instruction: ${prompt}. ` +
            `Preserve identity, important facial features, ` +
            `composition and realistic details unless the instruction ` +
            `explicitly asks to change them.`;

        } else if (operation === "variations") {

          finalPrompt =
            `Create a fresh professional variation of this image. ` +
            `${prompt || "Explore a different composition, lighting, camera angle, " +
            "and premium visual treatment while preserving the main subject."}`;

        } else {

          finalPrompt =
            `${prompt}. ` +
            `${styleHint(style)}. ` +
            `Composition ratio ${ratio}.`;
        }

        try {

          generatedImage =
            await client.imageToImage({
              model:
                "black-forest-labs/FLUX.2-klein-9B",

              inputs:
                toBlob(reference),

              parameters: {
                prompt: finalPrompt,

                strength:
                  clamp(
                    Number(strength) / 100,
                    0.05,
                    0.95
                  )
              }
            });

        } catch (referenceError) {

          console.error(
            "Image-to-image error:",
            referenceError
          );

          if (operation !== "generate") {
            throw referenceError;
          }
        }
      }

      /* =========================
         TEXT-TO-IMAGE FALLBACK
      ========================= */

      if (!generatedImage) {

        const finalPrompt =
          `${prompt}. ` +
          `${styleHint(style)}. ` +
          `Composition ratio ${ratio}. ` +
          `High quality, sharp details, ` +
          `professional visual composition.`;

        generatedImage =
          await client.textToImage({
            provider: "auto",
            model:
              "black-forest-labs/FLUX.1-schnell",
            inputs: finalPrompt
          });
      }

      images.push(
        await dataUrl(generatedImage)
      );
    }

    /* =========================
       SUCCESS
    ========================= */

    return res.status(200).json({
      images
    });

  } catch (error) {

    console.error(
      "ArtEraAI generation error:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Generation failed."
    });
  }
                                   }

import { InferenceClient } from "@huggingface/inference";

const MAX_PROMPT_LENGTH = 1200;
const MAX_IMAGE_BYTES = Math.floor(2.8 * 1024 * 1024);
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_OPERATIONS = new Set(["generate", "edit", "background", "variations", "remove"]);

function json(res, status, body) { return res.status(status).json(body); }
function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function styleHint(style) {
  const hints = {
    Realistic: "photorealistic, natural textures, realistic lighting",
    Cinematic: "cinematic composition, dramatic lighting, film color grading",
    "Premium Poster": "premium poster design, polished composition, crisp details",
    "3D Render": "high-quality 3D render, detailed materials, studio lighting",
    "Digital Art": "professional digital artwork, refined details",
    Anime: "anime illustration, clean linework, expressive colors",
  };
  return hints[style] || hints.Realistic;
}
function decodeImage(data) {
  if (typeof data !== "string") throw new Error("INVALID_IMAGE");
  const m = data.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!m || !ALLOWED_MIME.has(m[1].toLowerCase())) throw new Error("INVALID_IMAGE");
  const b = Buffer.from(m[2].replace(/\s/g, ""), "base64");
  if (!b.length || b.length > MAX_IMAGE_BYTES) throw new Error("IMAGE_SIZE");
  const mime = m[1].toLowerCase();
  const valid = (mime === "image/png" && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (mime === "image/jpeg" && b[0] === 255 && b[1] === 216 && b[2] === 255) ||
    (mime === "image/webp" && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP");
  if (!valid) throw new Error("INVALID_IMAGE");
  return new Blob([b], { type: mime });
}
async function imageDataUrl(image) {
  if (typeof image === "string") return image.startsWith("data:image/") ? image : `data:image/png;base64,${image}`;
  if (image && typeof image.arrayBuffer === "function") {
    const bytes = Buffer.from(await image.arrayBuffer());
    return `data:${image.type || "image/png"};base64,${bytes.toString("base64")}`;
  }
  throw new Error("Unexpected image response from provider");
}
function safeMessage(error) {
  const m = String(error?.message || "");
  if (/credit|payment|billing|quota|balance/i.test(m)) return "Hugging Face reports that credits or quota may be exhausted. Check account usage.";
  if (/unauthor|forbidden|token|credential|401|403/i.test(m)) return "The AI provider rejected HF_TOKEN. Check the Vercel Environment Variable.";
  if (/model|provider|task|not supported|404|400/i.test(m)) return "The selected AI model/provider rejected the request. Check model access and provider availability.";
  if (/timeout|503|502|overload|temporar/i.test(m)) return "The AI provider is temporarily unavailable. Please try again shortly.";
  return "The AI service could not complete this request. Check Vercel Function Logs for the provider error.";
}

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed." });
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return json(res, 415, { error: "Send the request as JSON." });
  }
  if (Number(req.headers["content-length"] || 0) > 4.1 * 1024 * 1024) {
    return json(res, 413, { error: "Request is too large. Please use a smaller image." });
  }

  let operation = "generate";
  try {
    if (!process.env.HF_TOKEN) throw new Error("MISSING_HF_TOKEN");
    const body = req.body || {};
    if (typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Invalid request body." });
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 4.1 * 1024 * 1024) return json(res, 413, { error: "Request is too large." });

    operation = typeof body.operation === "string" ? body.operation : "generate";
    if (!ALLOWED_OPERATIONS.has(operation)) return json(res, 400, { error: "Unsupported operation." });
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length > MAX_PROMPT_LENGTH) return json(res, 400, { error: `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.` });
    const style = typeof body.style === "string" ? body.style : "Realistic";
    const ratio = ["1:1", "4:5", "9:16", "16:9"].includes(body.ratio) ? body.ratio : "1:1";
    const strength = clamp(body.strength, 5, 95, 65) / 100;
    const count = operation === "variations" ? 4 : Math.floor(clamp(body.count, 1, 4, 1));
    let reference = null;
    if (body.reference) {
      try { reference = decodeImage(body.reference); }
      catch (e) { return json(res, 400, { error: e?.message === "IMAGE_SIZE" ? "Reference image must be under 2.8 MB." : "Reference image must be a valid PNG, JPEG, or WebP file." }); }
    }
    if (["edit", "background", "variations", "remove"].includes(operation) && !reference) return json(res, 400, { error: "Please upload a reference image first." });
    if (["generate", "edit", "background"].includes(operation) && !prompt) return json(res, 400, { error: "Please enter a prompt." });

    const hf = new InferenceClient(process.env.HF_TOKEN);
    if (operation === "remove") {
      const result = await hf.imageSegmentation({ model: "briaai/RMBG-2.0", inputs: reference });
      const items = Array.isArray(result) ? result : [result];
      const best = items.find((item) => item && item.mask);
      if (!best?.mask) return json(res, 502, { error: "The background-removal model did not return a mask." });
      let mask = best.mask;
      if (typeof mask === "string" && !mask.startsWith("data:")) mask = `data:image/png;base64,${mask}`;
      else if (mask && typeof mask.arrayBuffer === "function") mask = await imageDataUrl(mask);
      return json(res, 200, { mask });
    }

    const images = [];
    for (let i = 0; i < count; i++) {
      let finalPrompt = prompt;
      if (operation === "variations") finalPrompt = `${prompt || "Create a fresh professional variation of this image, changing composition and lighting while preserving the main subject."}. ${styleHint(style)}. Aspect ratio ${ratio}.`;
      if (reference) {
        if (operation === "background") finalPrompt = `Preserve the main subject and replace only the background with: ${prompt}. Keep the subject natural and realistically integrated.`;
        if (operation === "edit") finalPrompt = `Edit the provided image according to this instruction: ${prompt}. Preserve identity and important facial features unless explicitly asked otherwise.`;
        const output = await hf.imageToImage({
          model: "black-forest-labs/FLUX.2-klein-9B",
          inputs: reference,
          parameters: { prompt: `${finalPrompt}. ${styleHint(style)}. Composition ratio ${ratio}.`, strength },
        });
        images.push(await imageDataUrl(output));
      } else {
        const output = await hf.textToImage({
          provider: "auto",
          model: "black-forest-labs/FLUX.1-schnell",
          inputs: `${prompt}. ${styleHint(style)}. Composition ratio ${ratio}. High quality, sharp details, professional visual composition.`,
          parameters: { num_inference_steps: 5 },
        });
        images.push(await imageDataUrl(output));
      }
    }
    return json(res, 200, { images });
  } catch (error) {
    const message = String(error?.message || "Unknown provider error").slice(0, 240);
    console.error("ArtEraAI API failure:", { operation, name: error?.name || "Error", status: error?.httpStatus || error?.status || null, message });
    return json(res, 502, { error: safeMessage(error) });
  }
}

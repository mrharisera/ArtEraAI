import { InferenceClient } from "@huggingface/inference";

const MAX_IMAGE_BYTES = Math.floor(2.8 * 1024 * 1024);
const MAX_BODY_BYTES = 4.1 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 1200;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_STYLES = new Set(["Realistic", "Cinematic", "Premium Poster", "3D Render", "Digital Art", "Anime"]);
const ALLOWED_RATIOS = new Set(["1:1", "4:5", "9:16", "16:9"]);
const ALLOWED_OPERATIONS = new Set(["generate", "edit", "remove", "background", "variations"]);

// Best-effort per-instance throttle. On serverless hosting this is not a
// distributed rate limiter; use a shared provider such as Upstash for stronger enforcement.
const buckets = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const LIMIT_POINTS = 12;

function setSecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function jsonError(res, status, error) {
  return res.status(status).json({ error });
}

function getClientKey(req) {
  // Vercel supplies x-real-ip. Fallback is only a best-effort identifier.
  const ip = req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return String(ip || "unknown").slice(0, 80);
}

function checkRateLimit(req, cost) {
  const now = Date.now();
  const key = getClientKey(req);
  let entry = buckets.get(key);
  if (!entry || now - entry.start >= WINDOW_MS) entry = { start: now, points: 0 };
  if (entry.points + cost > LIMIT_POINTS) {
    buckets.set(key, entry);
    return false;
  }
  entry.points += cost;
  buckets.set(key, entry);
  // Keep this per-instance map bounded.
  if (buckets.size > 1000) {
    for (const [k, v] of buckets) if (now - v.start >= WINDOW_MS) buckets.delete(k);
    if (buckets.size > 1000) buckets.delete(buckets.keys().next().value);
  }
  return true;
}

function decodeImage(data) {
  if (typeof data !== "string") throw new Error("INVALID_IMAGE");
  const match = data.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !ALLOWED_MIME.has(match[1])) throw new Error("INVALID_IMAGE");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
  // Check file signatures instead of trusting the declared MIME type.
  const mime = match[1];
  const validPng = mime === "image/png" && buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const validJpeg = mime === "image/jpeg" && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const validWebp = mime === "image/webp" && buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  if (!(validPng || validJpeg || validWebp)) throw new Error("INVALID_IMAGE");
  return new Blob([buffer], { type: mime });
}

const styleHint = (style) => ({
  Realistic: "photorealistic, natural textures, realistic lighting",
  Cinematic: "cinematic film lighting, dramatic depth, cinematic composition",
  "Premium Poster": "premium commercial poster, polished composition",
  "3D Render": "high-end 3D render, detailed materials, realistic reflections",
  "Digital Art": "high-detail digital artwork, polished professional finish",
  Anime: "high-quality anime illustration, detailed character art"
}[style] || "photorealistic, polished professional finish");

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);

const dataUrl = async (blob) => {
  const buffer = Buffer.from(await blob.arrayBuffer());
  return `data:${blob.type || "image/png"};base64,${buffer.toString("base64")}`;
};

export default async function handler(req, res) {
  setSecurityHeaders(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonError(res, 405, "Method not allowed.");
  }
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return jsonError(res, 415, "Please send a JSON request.");
  }
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) return jsonError(res, 413, "Request is too large. Use an image smaller than 2.8 MB.");
  if (!process.env.HF_TOKEN) return jsonError(res, 500, "AI service is not configured. Please try again later.");

  let operation = "generate";
  try {
    const body = req.body || {};
    if (typeof body !== "object" || Array.isArray(body)) return jsonError(res, 400, "Invalid request body.");
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) return jsonError(res, 413, "Request is too large. Use an image smaller than 2.8 MB.");

    operation = typeof body.operation === "string" ? body.operation : "generate";
    if (!ALLOWED_OPERATIONS.has(operation)) return jsonError(res, 400, "Unsupported studio operation.");
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length > MAX_PROMPT_LENGTH) return jsonError(res, 400, `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`);
    const style = ALLOWED_STYLES.has(body.style) ? body.style : "Realistic";
    const ratio = ALLOWED_RATIOS.has(body.ratio) ? body.ratio : "1:1";
    const strength = clamp(body.strength, 0, 100);
    const count = operation === "variations" ? 4 : Math.min(Math.max(Number(body.count) || 1, 1), 4);
    const needsReference = ["edit", "remove", "background", "variations"].includes(operation);
    let referenceBlob = null;
    if (body.reference !== undefined && body.reference !== null && body.reference !== "") {
      try { referenceBlob = decodeImage(body.reference); }
      catch (e) {
        if (e.message === "IMAGE_TOO_LARGE") return jsonError(res, 413, "Image is too large. Maximum size is 2.8 MB.");
        return jsonError(res, 400, "Reference image must be a valid PNG, JPG, or WebP file.");
      }
    }
    if (needsReference && !referenceBlob) return jsonError(res, 400, "Please select or upload an image first.");
    if (operation !== "remove" && operation !== "variations" && !prompt) return jsonError(res, 400, "Please enter a prompt.");
    const rateCost = operation === "variations" ? 4 : count;
    if (!checkRateLimit(req, rateCost)) {
      res.setHeader("Retry-After", "600");
      return jsonError(res, 429, "Too many requests from this connection. Please wait a few minutes and try again.");
    }

    const client = new InferenceClient(process.env.HF_TOKEN);
    if (operation === "remove") {
      const segments = await client.imageSegmentation({ model: "briaai/RMBG-2.0", inputs: referenceBlob });
      const best = Array.isArray(segments) ? segments.filter(item => item?.mask).sort((a,b) => (b.score || 0) - (a.score || 0))[0] : null;
      if (!best?.mask) return jsonError(res, 502, "Background mask could not be created. Please try again.");
      let maskData = best.mask;
      if (typeof maskData === "string" && !maskData.startsWith("data:")) maskData = `data:image/png;base64,${maskData}`;
      return res.status(200).json({ mask: maskData });
    }

    const images = [];
    for (let i = 0; i < count; i++) {
      let generatedImage = null;
      if (referenceBlob) {
        let finalPrompt;
        if (operation === "background") {
          finalPrompt = `Preserve the main subject and replace ONLY the background. New background: ${prompt}. Keep the subject natural, sharp, correctly lit, and professionally integrated.`;
        } else if (operation === "edit") {
          finalPrompt = `Edit the provided image according to this instruction: ${prompt}. Preserve identity, important facial features, composition and realistic details unless the instruction explicitly asks to change them.`;
        } else if (operation === "variations") {
          finalPrompt = `Create a fresh professional variation of this image. ${prompt || "Explore a different composition, lighting, camera angle, and premium visual treatment while preserving the main subject."}`;
        } else {
          finalPrompt = `${prompt}. ${styleHint(style)}. Composition ratio ${ratio}.`;
        }
        try {
          generatedImage = await client.imageToImage({
            model: "black-forest-labs/FLUX.2-klein-9B",
            inputs: referenceBlob,
            parameters: { prompt: finalPrompt, strength: clamp(strength / 100, 0.05, 0.95) }
          });
        } catch (e) {
          // Do not expose provider internals or user prompts in logs/responses.
          if (operation !== "generate") throw e;
        }
      }
      if (!generatedImage) {
        const finalPrompt = `${prompt}. ${styleHint(style)}. Composition ratio ${ratio}. High quality, sharp details, professional visual composition.`;
        generatedImage = await client.textToImage({ provider: "auto", model: "black-forest-labs/FLUX.1-schnell", inputs: finalPrompt });
      }
      images.push(await dataUrl(generatedImage));
    }
    return res.status(200).json({ images });
  } catch (error) {
    // Log only the operation and error class, not prompts, images, or tokens.
    console.error("ArtEraAI API failure:", { operation, errorName: error?.name || "Error" });
    return jsonError(res, 502, "The AI service could not complete this request. Please try again later.");
  }
}

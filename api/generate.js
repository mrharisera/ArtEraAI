// ArtEraAI Pollinations API adapter. Set POLLINATIONS_API_KEY in Vercel Environment Variables.
// Keep this secret server-side; never put it in index.html or commit it to client code.
const MAX_PROMPT_LENGTH = 1200;
const ALLOWED_STYLES = new Set(["Realistic", "Cinematic", "Premium Poster", "3D Render", "Digital Art", "Anime"]);
const ALLOWED_RATIOS = new Set(["1:1", "4:5", "9:16", "16:9"]);

function reply(res, status, body) { return res.status(status).json(body); }
function styleHint(style) {
  return ({
    Realistic: "photorealistic, natural textures, realistic lighting",
    Cinematic: "cinematic film lighting, dramatic depth, film color grading",
    "Premium Poster": "premium commercial poster, polished composition, crisp details",
    "3D Render": "high-end 3D render, detailed materials, studio lighting",
    "Digital Art": "professional digital artwork, refined details",
    Anime: "anime illustration, clean linework, expressive colors"
  })[style] || "photorealistic, natural textures, realistic lighting";
}
function ratioHint(ratio) {
  return ({ "1:1": "square 1:1 aspect ratio", "4:5": "portrait 4:5 aspect ratio", "9:16": "vertical 9:16 aspect ratio", "16:9": "landscape 16:9 aspect ratio" })[ratio] || "square 1:1 aspect ratio";
}
function errorMessage(status) {
  if (status === 401 || status === 403) return "Pollinations rejected the API key. Check POLLINATIONS_API_KEY in Vercel Environment Variables.";
  if (status === 402) return "The image provider reports that the account balance or request budget is exhausted. Check provider usage.";
  if (status === 429) return "The image provider is rate-limiting requests. Wait a little and try again.";
  if (status === 502 || status === 503) return "The image provider is temporarily unavailable. Try again shortly.";
  return "The image provider could not complete the request. Check Vercel Function Logs.";
}

export default async function handler(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return reply(res, 405, { error: "Method not allowed." }); }

  try {
    const body = req.body || {};
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply(res, 400, { error: "Invalid request body." });
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 4 * 1024 * 1024) return reply(res, 413, { error: "Request is too large." });

    const operation = typeof body.operation === "string" ? body.operation : "generate";
    // This adapter only implements text-to-image. It deliberately does not fake image editing/removal.
    if (!["generate", "variations"].includes(operation)) return reply(res, 501, { error: "This API version supports text-to-image generation only. Image editing and background removal require a separate compatible provider." });
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return reply(res, 400, { error: "Please enter a prompt." });
    if (prompt.length > MAX_PROMPT_LENGTH) return reply(res, 400, { error: `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.` });

    const key = process.env.POLLINATIONS_API_KEY;
    if (!key) return reply(res, 500, { error: "Pollinations is not configured. Add POLLINATIONS_API_KEY in Vercel Environment Variables." });
    const style = ALLOWED_STYLES.has(body.style) ? body.style : "Realistic";
    const ratio = ALLOWED_RATIOS.has(body.ratio) ? body.ratio : "1:1";
    const count = operation === "variations" ? 4 : Math.floor(Math.min(4, Math.max(1, Number(body.count) || 1)));
    const sizes = { "1:1": [1024, 1024], "4:5": [832, 1040], "9:16": [768, 1365], "16:9": [1024, 576] };
    const [width, height] = sizes[ratio];
    const images = [];

    for (let i = 0; i < count; i++) {
      const variant = operation === "variations" ? `Variation ${i + 1}: use a distinct composition and lighting treatment.` : "";
      const fullPrompt = `${prompt}. ${styleHint(style)}. ${ratioHint(ratio)}. High quality, sharp details. ${variant}`;
      const url = new URL(`https://gen.pollinations.ai/image/${encodeURIComponent(fullPrompt)}`);
      url.searchParams.set("model", "flux");
      url.searchParams.set("width", String(width));
      url.searchParams.set("height", String(height));
      url.searchParams.set("nologo", "true");
      const upstream = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}` } });
      if (!upstream.ok) {
        console.error("ArtEraAI Pollinations request failed", { status: upstream.status, operation });
        return reply(res, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, { error: errorMessage(upstream.status) });
      }
      const mime = (upstream.headers.get("content-type") || "").toLowerCase();
      if (!mime.startsWith("image/")) return reply(res, 502, { error: "The image provider returned an unexpected response." });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (!bytes.length || bytes.length > 12 * 1024 * 1024) return reply(res, 502, { error: "The generated image was empty or too large." });
      images.push(`data:${mime};base64,${bytes.toString("base64")}`);
    }
    return reply(res, 200, { images });
  } catch (error) {
    console.error("ArtEraAI Pollinations API error", { name: error?.name || "Error", message: String(error?.message || "Unknown error").slice(0, 180) });
    return reply(res, 502, { error: "The image provider could not complete the request. Check Vercel Function Logs." });
  }
}

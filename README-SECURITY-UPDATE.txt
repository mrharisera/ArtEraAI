ArtEraAI Security & Privacy Update — V4.1

Files included:
- index.html (same V4.1 interface, safer upload checks/history, privacy links and clear-history control)
- api/generate.js (server-side validation, size checks, allowed operations, safer errors, best-effort per-instance throttling)
- privacy-policy.html and terms.html
- sitemap.xml and robots.txt
- vercel.json (security response headers)

IMPORTANT BEFORE UPLOADING
1. Keep your existing package.json unless you are certain the included @huggingface/inference dependency is already present. The current API imports @huggingface/inference, so package.json must include it.
2. Keep HF_TOKEN only in Vercel Environment Variables (Production, and Preview if needed). Never paste the token into GitHub or index.html.
3. Upload/replace files preserving folders: index.html at repository root; api/generate.js inside the api folder; privacy-policy.html, terms.html, sitemap.xml, robots.txt and vercel.json at repository root.
4. Deploy, then test Generate (one image), reference-image generation, Edit, Background Replace, Remove Background, 4 Variations, and mobile layout. If anything fails, revert api/generate.js first to the previous working version.

LIMITATIONS
- The in-memory request throttle is best-effort only and may reset or be split across Vercel serverless instances. It is not a full distributed abuse-prevention system.
- Browser history is stored locally in the visitor's browser until they clear it; it is not a cloud account history.
- Prompts and uploaded reference images are sent to the configured AI provider to process the request. Review the provider's current terms/privacy information. Do not upload sensitive/private images.
- This package does not guarantee complete security or indexing/ranking.

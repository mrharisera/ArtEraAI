# ArtEraAI V4.1

Premium AI image studio with secure Vercel + Hugging Face backend.

## Files
- `index.html` — responsive ArtEraAI V4.1 UI and same-page AI Studio tools
- `api/generate.js` — generation, image-to-image editing, background replacement, variations, and background-mask workflow
- `package.json` — Hugging Face dependency

## Deploy
1. Upload these files to the GitHub repository root.
2. Keep `api/generate.js` inside the `api` folder.
3. In Vercel, keep `HF_TOKEN` as a Production Environment Variable. Never put the token in GitHub.
4. Redeploy after committing.

## V4.1 Studio
- Edit Image: prompt-based image editing
- Remove Background: segmentation mask + transparent PNG compositing in the browser
- Background Replace: prompt-based background transformation
- 4 Variations: four image-to-image directions
All tools open on the same page and can use the current artwork or a new upload.

Created by Haris King Era

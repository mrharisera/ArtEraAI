# ArtEraAI

## Deploy
1. Import this folder into Vercel.
2. Add an environment variable named `HF_TOKEN`.
3. Put your Hugging Face access token in that variable.
4. Deploy.

The token stays server-side; it is not placed in the HTML.

The current backend uses Hugging Face Inference Providers. Availability and free credits can change, so generation depends on the account/provider's current access and remaining credits.

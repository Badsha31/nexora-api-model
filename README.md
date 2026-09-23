# Nexora API Model

Production-oriented Cloudflare Worker API/control plane for Nexora AI.

## Features

- OpenAI-compatible `/v1/models`
- OpenAI-compatible `/v1/chat/completions`
- Cloudflare Workers AI inference
- D1-backed API key storage
- SHA-256 hashed API keys at rest
- Master Admin password
- Generate/revoke API keys
- One-time full key display
- Generated model/API URLs
- Request counters and usage records
- CORS
- No provider/model credentials exposed to API consumers

## Deploy

1. Install Node.js 22+.
2. Install dependencies:
   `npm install`
3. Create D1:
   `npx wrangler d1 create nexora-api`
4. Put the returned database id into `wrangler.toml`.
5. Apply migration:
   `npx wrangler d1 migrations apply nexora-api --remote`
6. Set the Master Admin password:
   `npx wrangler secret put NEXORA_ADMIN_PASSWORD`
7. Deploy:
   `npm run deploy`

After deployment open:

`https://YOUR-WORKER.workers.dev/admin`

Generate an API key there. The generated response includes the API base URL and chat/models URLs.

## Nexora AI connection

Use the generated Worker base URL as:

`NEXORA_MODEL_URL=https://YOUR-WORKER.workers.dev/v1`

Use:

`NEXORA_MODEL_NAME=nexora-coder`

and the generated API key as:

`NEXORA_MODEL_API_KEY=YOUR_GENERATED_KEY`

## Important

No model can honestly be guaranteed to be the world's best or perfect. This service is the API/control layer; model quality depends on the configured Workers AI model and the agent/orchestration layer using it.

For heavier self-hosted coding models, keep the same OpenAI-compatible contract and place inference behind a suitable GPU service/API gateway rather than trying to run a large model inside a normal Worker.

Never commit admin passwords, API keys, model credentials, or D1 secrets to Git.

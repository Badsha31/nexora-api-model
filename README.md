# Nexora API Model

Production-oriented Cloudflare Worker API/control plane for Nexora AI.

## Features

- OpenAI-compatible `/v1/models`
- OpenAI-compatible `/v1/chat/completions`
- Cloudflare Workers AI inference
- Turso-backed API key and usage storage
- SHA-256 hashed API keys at rest
- Master Admin password
- Generate/revoke API keys
- One-time full key display
- Generated model/API URLs
- Request counters and usage records
- CORS
- No provider/model credentials exposed to API consumers

## Deploy

1. Keep the Worker connected to your Turso database.
2. In Cloudflare Worker Secrets/Variables, set:
   - `TURSO_DATABASE_URL` — your Turso `libsql://...` URL
   - `TURSO_AUTH_TOKEN` — your Turso auth token (Secret)
   - `NEXORA_ADMIN_PASSWORD` — Master Admin password (Secret)
3. Build command:
   `npm install`
4. Deploy command:
   `npx wrangler deploy`

No Cloudflare D1 database or D1 `database_id` is required.

### Turso schema

Run the SQL in `migrations/0001_init.sql` once against your Turso database. The schema creates the `api_keys` and `usage` tables used by the Worker.

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

Never commit admin passwords, API keys, model credentials, or Turso secrets to Git.

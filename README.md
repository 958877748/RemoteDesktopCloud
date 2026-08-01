# Personal Agent MCP

A minimal remote MCP server running on Cloudflare Workers.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/958877748/personal-agent-mcp)

Click the button above to deploy this repository to your Cloudflare account. Cloudflare will create/configure the Worker and deploy it using the repository's Wrangler configuration.

## Endpoints

- Health check: `/`
- MCP endpoint: `/mcp`

After deployment, connect your MCP client to:

`https://<your-worker>.<your-subdomain>.workers.dev/mcp`

## Local development

```bash
npm install
npm run dev
```

Then test with MCP Inspector against:

`http://localhost:8787/mcp`

## Manual deployment

```bash
npm install
npm run deploy
```

Make sure you have authenticated Wrangler first:

```bash
npx wrangler login
```

## Tool

The server currently exposes one test tool:

- `sprite_test` — echoes a message and returns server metadata.

## Notes

This project uses Cloudflare's current stateless MCP handler approach through the Agents SDK. The `/mcp` endpoint is the remote MCP transport endpoint.

# VPS deployment preflight

This webhook receiver is an optional automation service. It is not required for Suraya's normal web/API operation and must not be enabled until the watched source service and separate deployment target are intentionally configured.

## Required secrets and configuration

Create a private `.env` file on the VPS (never commit it) with:

- `RENDER_WEBHOOK_SECRET`: secret from the Render webhook configuration
- `RENDER_API_KEY`: Render API key with the minimum service/deploy permissions needed
- `RENDER_SOURCE_SERVICE_ID`: the service whose successful deployment should trigger the workflow
- `RENDER_TARGET_SERVICE_ID`: a different service that the workflow is allowed to deploy
- `GITHUB_API_TOKEN`: fine-grained token limited to the selected repository and Actions: write
- `GITHUB_OWNER_NAME`, `GITHUB_REPO_NAME`
- `GITHUB_WORKFLOW_ID`: exact workflow file name or ID
- `GITHUB_WORKFLOW_REF`: branch containing the workflow (default: main)

The app refuses to start if source and target service IDs are missing, invalid, or equal. Equal IDs would cause an automatic redeploy loop.

## Start

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3001/health
```

The service binds to loopback only. Put a TLS reverse proxy in front of `/webhook`, configure the Render webhook to send only the required deploy-ended event, and do not expose port 3001 directly. The container runs as non-root, read-only, without Linux capabilities.

## Operational caveats

- Duplicate event suppression is in-memory and resets on restart. For high-assurance production automation, use a durable idempotency store before enabling the webhook.
- Test with a non-production source and target service first.
- Never use a broad personal GitHub token or a full-access Render API key.
- Do not configure source and target as the same service.

import { Octokit } from "@octokit/core";
import express, { NextFunction, Request, Response } from "express";
import {
  Webhook,
  WebhookUnbrandedRequiredHeaders,
  WebhookVerificationError
} from "standardwebhooks";
import { RenderDeploy, RenderEvent, RenderService, WebhookPayload } from "./render";

const app = express();
const port = Number(process.env.PORT) || 3001;
const renderWebhookSecret = process.env.RENDER_WEBHOOK_SECRET || "";
const renderAPIURL = process.env.RENDER_API_URL || "https://api.render.com/v1";
const renderAPIToken = process.env.RENDER_API_KEY || "";
const githubAPIToken = process.env.GITHUB_API_TOKEN || "";
const githubOwnerName = process.env.GITHUB_OWNER_NAME || "";
const githubRepoName = process.env.GITHUB_REPO_NAME || "";
const githubWorkflowID = process.env.GITHUB_WORKFLOW_ID || "example.yaml";
const githubWorkflowRef = process.env.GITHUB_WORKFLOW_REF || "main";
const sourceServiceId = process.env.RENDER_SOURCE_SERVICE_ID || "";
const targetServiceId = process.env.RENDER_TARGET_SERVICE_ID || "";

if (!renderWebhookSecret || !renderAPIToken || !githubAPIToken ||
    !githubOwnerName || !githubRepoName || !sourceServiceId || !targetServiceId) {
  throw new Error("Missing required webhook, Render, GitHub, source-service, or target-service configuration.");
}
if (!/^srv-[a-z0-9]+$/.test(sourceServiceId) ||
    !/^srv-[a-z0-9]+$/.test(targetServiceId) ||
    sourceServiceId === targetServiceId) {
  throw new Error("RENDER_SOURCE_SERVICE_ID and RENDER_TARGET_SERVICE_ID must be valid, distinct Render service IDs.");
}
if (!/^[A-Za-z0-9_.-]+$/.test(githubWorkflowRef)) {
  throw new Error("GITHUB_WORKFLOW_REF must be a branch or tag name without path separators.");
}

const octokit = new Octokit({ auth: githubAPIToken });
const inFlightEvents = new Set<string>();
const processedEvents = new Set<string>();

app.disable("x-powered-by");
app.get("/health", (_req: Request, res: Response) => res.status(200).json({ ok: true }));

app.post(
  "/webhook",
  express.raw({ type: "application/json", limit: "256kb" }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      validateWebhook(req);
      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ ok: false, error: "Expected application/json webhook body." });
      }
      const payload = JSON.parse(req.body.toString("utf8")) as WebhookPayload;
      const result = await handleWebhook(payload);
      return res.status(202).json({ accepted: true, result });
    } catch (error) {
      return next(error);
    }
  }
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof WebhookVerificationError ? 400 :
    err instanceof SyntaxError ? 400 : 500;
  console.error("Webhook request failed:", err instanceof Error ? err.message : "unknown error");
  return res.status(status).json({ ok: false, error: status === 400 ? "Invalid webhook request." : "Webhook processing failed." });
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Webhook receiver listening on port ${port}`);
});

function validateWebhook(req: Request) {
  const headers: WebhookUnbrandedRequiredHeaders = {
    "webhook-id": req.header("webhook-id") || "",
    "webhook-timestamp": req.header("webhook-timestamp") || "",
    "webhook-signature": req.header("webhook-signature") || ""
  };
  new Webhook(renderWebhookSecret).verify(req.body, headers);
}

async function handleWebhook(payload: WebhookPayload): Promise<string> {
  if (payload.type !== "deploy_ended") return "ignored_event_type";
  if (!payload.data?.id || payload.data.serviceId !== sourceServiceId) return "ignored_source_service";

  const eventId = payload.data.id;
  if (processedEvents.has(eventId) || inFlightEvents.has(eventId)) return "duplicate_event";
  inFlightEvents.add(eventId);

  try {
    const event = await fetchEventInfo(payload);
    if (event.type !== "deploy_ended" || Number(event.details?.status) !== 2 ||
        typeof event.details?.deployId !== "string") {
      processedEvents.add(eventId);
      return "ignored_unsuccessful_deploy";
    }

    const sourceService = await fetchServiceInfo(sourceServiceId);
    const sourceRepo = new URL(sourceService.repo).pathname.replace(/\\.git$/i, "").replace(/^\\/+|\\/+$/g, "");
    const expectedRepo = `${githubOwnerName}/${githubRepoName}`;
    if (sourceRepo.toLowerCase() !== expectedRepo.toLowerCase()) {
      processedEvents.add(eventId);
      return "ignored_untrusted_source_repository";
    }

    const deploy = await fetchDeployInfo(sourceServiceId, event.details.deployId);
    if (!deploy.commit) {
      processedEvents.add(eventId);
      return "ignored_image_backed_deploy";
    }

    // Crucial loop guard: the successful source service triggers a workflow
    // that deploys a different, explicitly configured target service.
    await triggerWorkflow(targetServiceId);
    processedEvents.add(eventId);
    return "target_deploy_dispatched";
  } finally {
    inFlightEvents.delete(eventId);
    if (processedEvents.size > 10000) {
      const oldest = processedEvents.values().next().value;
      if (oldest) processedEvents.delete(oldest);
    }
  }
}

async function triggerWorkflow(serviceID: string) {
  await octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
    owner: githubOwnerName,
    repo: githubRepoName,
    workflow_id: githubWorkflowID,
    ref: githubWorkflowRef,
    inputs: { serviceID },
    headers: { "X-GitHub-Api-Version": "2022-11-28" }
  });
}

async function fetchEventInfo(payload: WebhookPayload): Promise<RenderEvent> {
  const res = await fetch(`${renderAPIURL}/events/${encodeURIComponent(payload.data.id)}`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${renderAPIToken}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`Render event lookup failed with HTTP ${res.status}.`);
  return res.json() as Promise<RenderEvent>;
}

async function fetchDeployInfo(serviceId: string, deployId: string): Promise<RenderDeploy> {
  const res = await fetch(
    `${renderAPIURL}/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
    {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${renderAPIToken}` },
      signal: AbortSignal.timeout(10000)
    }
  );
  if (!res.ok) throw new Error(`Render deploy lookup failed with HTTP ${res.status}.`);
  return res.json() as Promise<RenderDeploy>;
}

async function fetchServiceInfo(serviceId: string): Promise<RenderService> {
  const res = await fetch(`${renderAPIURL}/services/${encodeURIComponent(serviceId)}`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${renderAPIToken}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`Render service lookup failed with HTTP ${res.status}.`);
  return res.json() as Promise<RenderService>;
}

function shutdown(signal: string) {
  console.log(signal + " received; closing webhook receiver.");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

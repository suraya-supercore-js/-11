const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.ts"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/example.yaml"), "utf8");
const render = fs.readFileSync(path.join(root, "render.yaml"), "utf8");

test("webhook requires distinct explicit source and target services", () => {
  assert.match(app, /RENDER_SOURCE_SERVICE_ID/);
  assert.match(app, /RENDER_TARGET_SERVICE_ID/);
  assert.match(app, /sourceServiceId === targetServiceId/);
});

test("only the configured source service can dispatch a workflow", () => {
  assert.match(app, /payload\.data\.serviceId !== sourceServiceId/);
  assert.match(app, /await triggerWorkflow\(targetServiceId\)/);
  assert.doesNotMatch(app, /triggerWorkflow\(sourceServiceId/);
});

test("duplicate event IDs are guarded in-process", () => {
  assert.match(app, /processedEvents\.has\(eventId\)/);
  assert.match(app, /inFlightEvents\.has\(eventId\)/);
});

test("workflow validates service ID and passes it through an environment variable", () => {
  assert.match(workflow, /SERVICE_ID: \$\{\{ inputs\.serviceID \}\}/);
  assert.match(workflow, /\^srv-\[a-z0-9\]\+\$/);
  assert.match(workflow, /render deploys create "\$SERVICE_ID"/);
  assert.equal(workflow.includes('render deploys create "${{ inputs.serviceID }}" '), false);
});

test("Render blueprint requires source and target service IDs as manual secrets/configuration", () => {
  assert.match(render, /key: RENDER_SOURCE_SERVICE_ID\s+sync: false/);
  assert.match(render, /key: RENDER_TARGET_SERVICE_ID\s+sync: false/);
});

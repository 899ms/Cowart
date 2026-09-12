import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  COWART_POSTHOG_HOST,
  cowartPosthogEventId,
  cowartPosthogPayload,
  sendCowartPosthogEvent,
} from "../mcp/lib/posthog-analytics.mjs";

const eventId = "3f1c9c1e-6f2a-4d1b-9f7e-2c8a5b0d4e77";
const payload = await cowartPosthogPayload({
  clientId: "123456789.1785751441",
  eventName: "widget_prompt_sent",
  appVersion: "test-version",
  eventId,
  projectToken: "phc_livetesttokenvalue",
  now: 1_770_000_000_000,
  parameters: {
    prompt_type: "annotation_edit",
    has_reference: "yes",
  },
});

assert.equal(payload.api_key, "phc_livetesttokenvalue");
assert.equal(payload.event, "widget_prompt_sent");
assert.equal(payload.distinct_id, "123456789.1785751441");
assert.equal(payload.uuid, eventId, "A widget-supplied uuid must survive unchanged for retry dedupe");
assert.equal(payload.timestamp, new Date(1_770_000_000_000).toISOString());
assert.equal(payload.properties.app_surface, "codex_widget");
assert.equal(payload.properties.app_version, "test-version");
assert.equal(payload.properties.$process_person_profile, false);
assert.equal(payload.properties.prompt_type, "annotation_edit");
assert.equal(payload.properties.has_reference, "yes");
assert.equal(Object.hasOwn(payload.properties, "prompt"), false);

const derivedA = await cowartPosthogEventId({ clientId: "1.2", eventName: "canvas_opened" });
const derivedB = await cowartPosthogEventId({ clientId: "1.2", eventName: "canvas_opened" });
assert.match(derivedA, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(derivedA, derivedB, "Derived uuids must be stable across retries");

let capturedUrl;
let capturedRequest;
const result = await sendCowartPosthogEvent({
  clientId: "123456789.1785751441",
  eventName: "canvas_opened",
  appVersion: "test-version",
  eventId,
  projectToken: "phc_livetesttokenvalue",
  async fetchImpl(url, request) {
    capturedUrl = url;
    capturedRequest = request;
    return { ok: true, status: 200, async json() { return { status: 1 }; } };
  },
});

assert.equal(capturedUrl, `${COWART_POSTHOG_HOST}/i/v0/e/`);
assert.equal(capturedRequest.method, "POST");
assert.equal(capturedRequest.headers["content-type"], "application/json");
const sent = JSON.parse(capturedRequest.body);
assert.equal(sent.api_key, "phc_livetesttokenvalue");
assert.equal(sent.event, "canvas_opened");
assert.equal(sent.uuid, eventId);
assert.deepEqual(result, { configured: true, delivered: true, status: 200 });

// Payload building must never invent a token; delivery is gated on real config.
const tokenless = await cowartPosthogPayload({
  clientId: "123456789.1785751441",
  eventName: "canvas_opened",
  appVersion: "test-version",
  projectToken: "",
});
assert.equal(tokenless.api_key, undefined);

// A plugin install without PostHog config must skip delivery instead of posting.
const emptyRoot = await mkdtemp(path.join(tmpdir(), "cowart-posthog-empty-"));
try {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { sendCowartPosthogEvent } from ${JSON.stringify(new URL("../mcp/lib/posthog-analytics.mjs", import.meta.url).href)};
       const result = await sendCowartPosthogEvent({
         clientId: "123456789.1785751441",
         eventName: "canvas_opened",
         appVersion: "test-version",
         fetchImpl() { throw new Error("PostHog must not be called without a project token"); },
       });
       console.log(JSON.stringify(result));`,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "COWART_POSTHOG_PROJECT_TOKEN"),
        ),
        COWART_PLUGIN_ROOT: emptyRoot,
      },
    },
  );
  assert.deepEqual(JSON.parse(stdout.trim()), { configured: false, delivered: false, status: null });
} finally {
  await rm(emptyRoot, { recursive: true, force: true });
}

console.log("Cowart PostHog capture probe OK");

import { readFile } from "node:fs/promises";

import { pluginPath } from "./plugin-root.mjs";

export const COWART_POSTHOG_HOST = "https://us.i.posthog.com";
export const COWART_POSTHOG_EVENT_NAMES = [
  "canvas_opened",
  "annotation_created",
  "ai_generation_requested",
  "widget_prompt_sent",
];

const POSTHOG_LOCAL_CONFIG_PATH = pluginPath(".codex-plugin", "posthog.local.json");
const POSTHOG_BUNDLED_CONFIG_PATH = pluginPath(".codex-plugin", "posthog.json");
const POSTHOG_CAPTURE_PATH = "/i/v0/e/";
const POSTHOG_REQUEST_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function projectTokenFromConfig(configPath) {
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    return nonEmptyString(config.projectToken);
  } catch {
    return undefined;
  }
}

export async function cowartPosthogProjectToken() {
  return nonEmptyString(process.env.COWART_POSTHOG_PROJECT_TOKEN)
    || await projectTokenFromConfig(POSTHOG_LOCAL_CONFIG_PATH)
    || await projectTokenFromConfig(POSTHOG_BUNDLED_CONFIG_PATH);
}

export function cowartPosthogHost(value) {
  const host = nonEmptyString(value) || COWART_POSTHOG_HOST;
  if (host !== COWART_POSTHOG_HOST) {
    throw new Error(`Unsupported PostHog host: ${host}`);
  }
  return host;
}

function hexFromBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// PostHog collapses repeated events when they share a uuid. Reusing the
// widget-provided event id keeps a retried MCP delivery, or the widget browser
// fallback, from double counting one user action; anything that is not already
// a uuid is mapped onto one deterministically.
export async function cowartPosthogEventId({ eventId, clientId, eventName }) {
  const provided = nonEmptyString(eventId);
  if (provided && UUID_PATTERN.test(provided)) return provided.toLowerCase();

  const source = provided || `${clientId}:${eventName}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cowart:${source}`)),
  );
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = hexFromBytes(digest.slice(0, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function cowartPosthogPayload({
  clientId,
  eventName,
  parameters = {},
  appVersion,
  eventId,
  projectToken,
  now = Date.now(),
}) {
  return {
    api_key: nonEmptyString(projectToken),
    event: eventName,
    distinct_id: clientId,
    uuid: await cowartPosthogEventId({ eventId, clientId, eventName }),
    timestamp: new Date(now).toISOString(),
    properties: {
      app_name: "cowart",
      app_version: appVersion,
      app_surface: "codex_widget",
      source: "codex_plugin_mcp",
      $lib: "cowart-mcp",
      // Product usage stays pseudonymous: no person profile is created.
      $process_person_profile: false,
      ...parameters,
    },
  };
}

export async function sendCowartPosthogEvent({
  clientId,
  eventName,
  parameters,
  appVersion,
  eventId,
  projectToken,
  fetchImpl = globalThis.fetch,
}) {
  const resolvedToken = nonEmptyString(projectToken) || await cowartPosthogProjectToken();
  if (!resolvedToken) {
    return { configured: false, delivered: false, status: null };
  }

  const payload = await cowartPosthogPayload({
    clientId,
    eventName,
    parameters,
    appVersion,
    eventId,
    projectToken: resolvedToken,
  });
  const response = await fetchImpl(`${COWART_POSTHOG_HOST}${POSTHOG_CAPTURE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(POSTHOG_REQUEST_TIMEOUT_MS),
  });

  return {
    configured: true,
    delivered: response.ok,
    status: response.status,
  };
}

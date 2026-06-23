import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

const ISSUER = (process.env.LUMENFALL_OIDC_ISSUER || "https://lumenfall.ai").replace(/\/$/, "");
const CLIENT_ID = process.env.LUMENFALL_OIDC_CLIENT_ID || "cli";
const SCOPES =
  process.env.LUMENFALL_OIDC_SCOPES ||
  "openid email profile generate balance.read offline_access keys:write";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const API_BASE = (process.env.LUMENFALL_API_BASE || "https://api.lumenfall.ai").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function topupUrl() { return `${ISSUER}/app/cli/connected`; }

/**
 * Mask a durable key so only the prefix and last 4 chars are visible.
 * "lmnfl_key_abc.SECRETvalue1234" → "lmnfl_key_abc.…1234"
 */
export function maskKey(key) {
  const dot = key.indexOf(".");
  const prefix = dot === -1 ? key.slice(0, 8) : key.slice(0, dot);
  return `${prefix}.…${key.slice(-4)}`;
}

// Reassurance form for the "just minted" moment: brand prefix + bullets + last 4.
// Unlike maskKey it hides the key id too — this line confirms success, it is not
// for identifying the key later (use `whoami` / `keys list` for that).
export function maskSecret(key) {
  return `lmnfl_${"•".repeat(13)}${key.slice(-4)}`;
}

// Pull the email out of an OIDC id_token for display ("Connected as …").
// Decode only (no signature check) — it is shown, never trusted. Built-ins only.
export function idTokenEmail(idToken) {
  if (!idToken) return null;
  try {
    const [, payload] = idToken.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).email || null;
  } catch {
    return null;
  }
}

/**
 * Parse CLI argv: first item is the subcommand, the rest are --flag value pairs.
 * parseArgs(["login", "--env-file", ".env"]) → { command: "login", flags: { "env-file": ".env" } }
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) {
      flags[rest[i].slice(2)] = rest[i + 1];
      i++;
    }
  }
  return { command, flags };
}

// ---------------------------------------------------------------------------
// Credential storage (exported for tests and other modules)
// ---------------------------------------------------------------------------

export function configDir() {
  return process.env.LUMENFALL_CONFIG_DIR || path.join(os.homedir(), ".lumenfall");
}

export function credentialPath() {
  return path.join(configDir(), "credentials.json");
}

export function storeCredential(cred) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    credentialPath(),
    JSON.stringify({ ...cred, created_at: cred.created_at || new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
  fs.chmodSync(credentialPath(), 0o600); // enforce even if the file pre-existed
}

export function loadCredential() {
  try {
    return JSON.parse(fs.readFileSync(credentialPath(), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Network helpers (exported for integration / E2E tests in S5)
// ---------------------------------------------------------------------------

/**
 * POST application/x-www-form-urlencoded with accept: application/json.
 * Rodauth returns HTML 302 without the accept header — this forces JSON.
 */
async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/**
 * Fetch the OpenID Connect discovery document from the issuer.
 * Returns the full metadata object (device_authorization_endpoint, token_endpoint, …).
 */
export async function discover() {
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`discovery failed: ${res.status}`);
  return res.json();
}

/**
 * Initiate a device-code flow.
 * Returns { device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in }.
 */
export async function requestDeviceCode(cfg) {
  const endpoint =
    cfg.device_authorization_endpoint || `${ISSUER}/device-authorization`;
  const { status, json } = await postForm(endpoint, {
    client_id: CLIENT_ID,
    scope: SCOPES,
  });
  if (status !== 200)
    throw new Error(
      `device authorization failed (${status}): ${JSON.stringify(json)}`
    );
  return json;
}

/**
 * Try to open `url` in the system default browser.
 * Silently succeeds even if no browser is available (CLI environment).
 */
function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      // `start` is a cmd.exe builtin, not an executable, so it must be run via
      // cmd. The empty "" is the window-title argument `start` expects before
      // the URL (otherwise a quoted URL would be taken as the title).
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * RFC 8628 §3.5 polling loop.
 * Handles: authorization_pending (keep polling), slow_down (back off +5 s),
 * expired_token / access_denied (fatal), and a hard deadline from expires_in.
 * Returns the token response { access_token, refresh_token, id_token, expires_in, scope }.
 */
export async function pollForToken(cfg, device) {
  const endpoint = cfg.token_endpoint || `${ISSUER}/token`;
  let interval = (device.interval || 5) * 1000;
  const deadline = Date.now() + (device.expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));

    const { status, json } = await postForm(endpoint, {
      grant_type: DEVICE_GRANT,
      device_code: device.device_code,
      client_id: CLIENT_ID,
    });

    if (status === 200) return json; // { access_token, refresh_token, id_token, expires_in, scope }

    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (json.error === "expired_token")
      throw new Error("The code expired. Run `lumenfall login` again.");
    if (json.error === "access_denied")
      throw new Error("Authorization was denied.");

    throw new Error(
      `token poll failed (${status}): ${JSON.stringify(json)}`
    );
  }

  throw new Error("Timed out waiting for authorization.");
}

/**
 * Mint a durable lmnfl_ API key via the platform.
 * Returns { api_key, key_id, organization_id } — the full api_key is plaintext exactly once.
 */
async function mintKey(accessToken, name) {
  const res = await fetch(`${ISSUER}/connect/api_keys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ name }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 201)
    throw new Error(`key minting failed (${res.status}): ${JSON.stringify(json)}`);
  return json; // { api_key, key_id, organization_id }
}

/**
 * Exchange the stored refresh_token for a fresh access token.
 *
 * Server policy is ROTATION: every refresh returns a NEW refresh_token and
 * invalidates the old one, so we MUST persist the new refresh_token back to
 * credentials.json on every successful refresh — otherwise the next refresh
 * fails with invalid_grant. On invalid_grant (expired / revoked / already
 * rotated) we tell the user to log in again and exit non-zero.
 *
 * Returns the access_token string.
 */
async function refreshAccessToken() {
  const c = requireCredential();
  if (!c.refresh_token) {
    console.error("No refresh token stored. Run `lumenfall login` again to enable account commands.");
    process.exit(1);
  }
  const endpoint = `${ISSUER}/token`;
  const { status, json } = await postForm(endpoint, {
    grant_type: "refresh_token",
    refresh_token: c.refresh_token,
    client_id: CLIENT_ID,
  });

  if (status !== 200) {
    if (json.error === "invalid_grant") {
      console.error("Your session has expired or was revoked. Run `lumenfall login` to sign in again.");
      process.exit(1);
    }
    throw new Error(`token refresh failed (${status}): ${JSON.stringify(json)}`);
  }

  // Rotation: persist the new refresh_token immediately so the old one is never
  // reused. The token endpoint may also rotate scope / expiry — keep them too.
  if (json.refresh_token) {
    storeCredential({ ...c, refresh_token: json.refresh_token });
  }
  if (!json.access_token) throw new Error("token refresh returned no access_token");
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function requireCredential() {
  const c = loadCredential();
  if (!c) { console.error("Not logged in. Run `lumenfall login` first."); process.exit(1); }
  return c;
}

/**
 * Render a /v1/balance response as a one-line human string.
 * Real shape: { object, billing_type, available: { amount, currency } }
 * `amount` is a dollar figure (already micros→dollars on the server) and is
 * null for postpaid accounts. Fall back gracefully for unexpected shapes.
 */
function formatBalance(json) {
  const available = json.available || {};
  const amount = available.amount;
  const currency = (available.currency || "usd").toUpperCase();
  if (json.billing_type === "postpaid" || amount == null) {
    return json.billing_type === "postpaid"
      ? "postpaid (billed in arrears)"
      : JSON.stringify(json);
  }
  return `${amount} ${currency}`;
}

async function cmdBalance() {
  const c = requireCredential();
  const res = await fetch(`${API_BASE}/v1/balance`, { headers: { authorization: `Bearer ${c.api_key}`, accept: "application/json" } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`balance check failed (${res.status})`);
  console.log(`  ${formatBalance(json)}`);
}

function cmdTopup() { console.log(`  Add a card / top up:\n\n    ${topupUrl()}\n`); openBrowser(topupUrl()); }

function cmdLogout() {
  try { fs.rmSync(credentialPath()); } catch {}
  console.log(`  Local credential removed. Revoke the key anytime at ${ISSUER}/app/api_keys`);
}

async function cmdLogin() {
  const cfg = await discover();
  const device = await requestDeviceCode(cfg);
  const url = device.verification_uri_complete || device.verification_uri;

  const opened = openBrowser(url);
  step(opened ? "Opening browser to approve…" : "Approve in your browser:");
  console.log(`    device code ${device.user_code}`);
  dim(url); // headless fallback + lets the user confirm the destination
  dim("waiting for approval…");

  const tokens = await pollForToken(cfg, device);
  // Prefer the id_token email (free); fall back to /userinfo since some OIDC
  // servers expose email only there even when the email scope was granted.
  let email = idTokenEmail(tokens.id_token);
  if (!email && tokens.access_token) {
    const { status, json } = await getJson(cfg.userinfo_endpoint || `${ISSUER}/userinfo`, tokens.access_token);
    if (status === 200) email = json.email || null;
  }
  ok(email ? `Approved. Connected as ${email}` : "Approved.");

  const minted = await mintKey(tokens.access_token, `Lumenfall CLI on ${os.hostname()}`);
  // Store the refresh_token (offline_access) so account-lane commands can mint
  // fresh short-lived access tokens later without re-running the device flow.
  storeCredential({ ...minted, issuer: ISSUER, refresh_token: tokens.refresh_token });
  ok(`Minted ${maskSecret(minted.api_key)} (durable)`);
  dim(`saved to ${credentialPath()}`);
  // The installer puts `lumenfall` on PATH; show the clean command, not the
  // resolved script path.
  dim(`load with: export LUMENFALL_API_KEY="$(lumenfall print-key)"`);
  return minted;
}

// ---------------------------------------------------------------------------
// Authed fetch helpers
// ---------------------------------------------------------------------------

/**
 * GET a JSON resource with a bearer token. Returns { status, json }.
 */
async function getJson(url, token) {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Account-lane commands (OIDC access token via refreshAccessToken)
// ---------------------------------------------------------------------------

async function cmdWhoami() {
  const c = requireCredential();
  // No refresh token (older credential / minimal scope): fall back to stored info.
  if (!c.refresh_token) {
    console.log(`org ${c.organization_id} · key ${maskKey(c.api_key)} · ${c.issuer}`);
    return;
  }
  const token = await refreshAccessToken();
  const { status, json } = await getJson(`${ISSUER}/userinfo`, token);
  if (status !== 200) throw new Error(`userinfo failed (${status}): ${JSON.stringify(json)}`);
  const name = json.name || json.preferred_username || "—";
  const email = json.email || "—";
  const org = json.org || json.organization || json.organization_name || c.organization_id || "—";
  console.log(`  name:  ${name}`);
  console.log(`  email: ${email}`);
  console.log(`  org:   ${org}`);
}

async function cmdKeysList() {
  const token = await refreshAccessToken();
  const { status, json } = await getJson(`${ISSUER}/connect/api_keys`, token);
  if (status !== 200) throw new Error(`keys list failed (${status}): ${JSON.stringify(json)}`);
  const keys = Array.isArray(json) ? json : json.api_keys || json.keys || [];
  if (keys.length === 0) { console.log("  No API keys."); return; }
  for (const k of keys) {
    const id = k.id || k.key_id || "—";
    const name = k.name || "—";
    const lastFour = k.last_four ? `…${k.last_four}` : "—";
    const created = k.created_at || k.created || "—";
    const status = k.status || (k.revoked ? "revoked" : "active");
    console.log(`  ${id}  ${lastFour}  ${name}  ${created}  ${status}`);
  }
}

async function cmdKeysCreate(name) {
  if (!name) { console.error("usage: lumenfall keys create <name>"); process.exit(1); }
  const token = await refreshAccessToken();
  const minted = await mintKey(token, name);
  console.log(`  Created key ${minted.key_id}. Copy it now — it is shown only once:\n`);
  console.log(`    ${minted.api_key}\n`);
}

async function cmdKeysRevoke(id) {
  if (!id) { console.error("usage: lumenfall keys revoke <id>"); process.exit(1); }
  const token = await refreshAccessToken();
  const res = await fetch(`${ISSUER}/connect/api_keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (res.status !== 200 && res.status !== 204) {
    const json = await res.json().catch(() => ({}));
    throw new Error(`key revoke failed (${res.status}): ${JSON.stringify(json)}`);
  }
  console.log(`  Revoked key ${id}.`);
}

async function cmdKeys(sub, arg) {
  switch (sub) {
    case "list": await cmdKeysList(); break;
    case "create": await cmdKeysCreate(arg); break;
    case "revoke": await cmdKeysRevoke(arg); break;
    default:
      console.error("usage: lumenfall keys <list|create <name>|revoke <id>>");
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Gateway-lane commands (stored lmnfl_ api_key as the bearer)
// ---------------------------------------------------------------------------

async function cmdModels() {
  const c = requireCredential();
  const { status, json } = await getJson(`${API_BASE}/openai/v1/models`, c.api_key);
  if (status !== 200) throw new Error(`models list failed (${status}): ${JSON.stringify(json)}`);
  const models = json.data || json.models || [];
  if (models.length === 0) { console.log("  No models returned."); return; }
  for (const m of models) console.log(`  ${m.id || m}`);
}

/**
 * POST a JSON body with a bearer token. Returns { status, json }.
 */
async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/**
 * Download `url` to `dest`, streaming the body to disk. Throws on a non-2xx
 * response so the caller can surface it like any other gateway error.
 */
async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`  Saved to ${dest} (${buf.length} bytes).`);
}

/**
 * Pull the upstream error_code out of a gateway error envelope, regardless of
 * whether it is flat ({ error_code }) or nested ({ error: { code | error_code } }).
 */
function errorCodeOf(json) {
  return json.error_code || json.error?.code || json.error?.error_code || null;
}

function gatewayErrorMessage(label, status, json) {
  const code = errorCodeOf(json);
  const msg = json.error?.message || json.message || JSON.stringify(json);
  const fix = suggestFix(code, status);
  return `${label} failed (${status})${code ? ` ${code}` : ""}: ${msg}\n\n  fix: ${fix}`;
}

async function cmdImage(prompt, flags) {
  if (!prompt) {
    console.error('usage: lumenfall image "<prompt>" [--model M] [--size WxH] [--output PATH] [--estimate]');
    process.exit(1);
  }
  const c = requireCredential();
  await generateImage(c.api_key, prompt, flags, flags.output);
}

async function cmdVideo(prompt, flags) {
  if (!prompt) {
    console.error('usage: lumenfall video "<prompt>" [--model M] [--size WxH] [--output PATH] [--estimate]');
    process.exit(1);
  }
  const c = requireCredential();
  await generateVideo(c.api_key, prompt, flags, flags.output);
}

// Back-compat alias: `generate` (and `generate --video`) still route to the
// image/video commands so existing muscle memory and docs keep working.
async function cmdGenerate(prompt, flags) {
  return flags.video ? cmdVideo(prompt, flags) : cmdImage(prompt, flags);
}

// `estimate <image|video> "<prompt>"` is the discoverable verb form of the
// `--estimate` flag — it runs the exact same request path with dryRun on, so
// there is a single source of truth for what gets priced.
async function cmdEstimate(modality, prompt, flags) {
  if (modality !== "image" && modality !== "video") {
    console.error('usage: lumenfall estimate <image|video> "<prompt>" [--model M] [--size WxH]');
    process.exit(1);
  }
  const withEstimate = { ...flags, estimate: true };
  return modality === "video" ? cmdVideo(prompt, withEstimate) : cmdImage(prompt, withEstimate);
}

function cmdDashboard() {
  const url = `${ISSUER}/app`;
  console.log(`  Opening dashboard:\n\n    ${url}\n`);
  openBrowser(url);
}

/**
 * Synchronous image generation via the OpenAI-compatible endpoint.
 * Response shape (engine api/openai/schemas.ts OpenAIImageGenerationResponse):
 *   { id, created, size?, output_format?, data: [{ url?, b64_json?, revised_prompt? }], metadata? }
 * The gateway request id is the top-level `id`. Image URLs are temporary; their
 * lifetime is account-configurable and not returned here, so we never hardcode it.
 */
/**
 * Format a micros cost (1/1,000,000 of a dollar) as a dollar string with 2-4
 * decimals, trailing zeros trimmed but never below 2 (40000 → "0.04",
 * 420000 → "0.42", 1500 → "0.0015").
 */
export function formatEstimateCost(micros) {
  const dollars = (Number(micros) || 0) / 1_000_000;
  let s = dollars.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (!s.includes(".")) s += ".00";
  else if (s.split(".")[1].length === 1) s += "0";
  return s;
}

// Collapse whitespace/newlines and cap length — upstream error messages can be
// long and multi-line, which wrecks list layouts.
export function truncate(s, n) {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

// POST the request with ?dryRun=true and print the cost estimate instead of
// generating. The engine returns { total_cost_micros, currency, model,
// provider, components } (see DryRunResponse).
async function estimateRequest(url, apiKey, body, label) {
  const { status, json } = await postJson(`${url}?dryRun=true`, apiKey, body);
  if (status !== 200) throw new Error(gatewayErrorMessage(`${label} estimate`, status, json));
  printEstimate(json);
}

function printEstimate(json) {
  console.log(`  estimate  ~$${formatEstimateCost(json.total_cost_micros)} ${json.currency || "USD"}`);
  const via = [json.model, json.provider && `via ${json.provider}`].filter(Boolean).join(" ");
  const breakdown = (json.components || [])
    .map((c) => {
      const q = c.billable_quantity ?? c.quantity;
      return `${q} ${c.metric}${q === 1 ? "" : "s"} @ $${c.unit_price}`;
    })
    .join(", ");
  const detail = [via, breakdown].filter(Boolean).join(" · ");
  if (detail) dim(detail);
}

async function generateImage(apiKey, prompt, flags, output) {
  const model = flags.model || "flux1.1-pro";
  const body = { model, prompt, n: 1 };
  if (flags.size) body.size = flags.size;

  if (flags.estimate) return estimateRequest(`${API_BASE}/openai/v1/images/generations`, apiKey, body, "image");

  const { status, json } = await postJson(`${API_BASE}/openai/v1/images/generations`, apiKey, body);
  if (status !== 200) throw new Error(gatewayErrorMessage("image generation", status, json));

  console.log(`  request: ${json.id || "—"}`);
  const data = json.data || [];
  const urls = data.map((d) => d.url).filter(Boolean);

  if (urls.length === 0) {
    // Could be a b64_json response (response_format defaults to url, but be graceful).
    if (data.some((d) => d.b64_json)) {
      console.log("  Returned base64 image data (no url). Re-run without forcing b64_json to get a url.");
    } else {
      console.log("  No image url in response.");
    }
    return;
  }

  for (const url of urls) console.log(`  ${url}`);

  if (output) {
    await downloadTo(urls[0], output);
  } else {
    console.log("\n  The url is temporary. Pass --output PATH to download and keep the image.");
  }
}

/**
 * Async video generation: submit returns 202 with a request id, then poll
 * GET /openai/v1/videos/:id until terminal. Reuses pollForToken's interval +
 * deadline style. Status values (engine toOpenAIStatus): queued | in_progress |
 * completed | failed. Completed carries output.url; failed carries error.
 */
async function generateVideo(apiKey, prompt, flags, output) {
  const model = flags.model || "kling-v3";
  const body = { model, prompt };
  if (flags.size) body.size = flags.size;

  if (flags.estimate) return estimateRequest(`${API_BASE}/openai/v1/videos`, apiKey, body, "video");

  const submit = await postJson(`${API_BASE}/openai/v1/videos`, apiKey, body);
  // 202 (accepted) is the normal async path; 200 covers an idempotent replay.
  if (submit.status !== 202 && submit.status !== 200) {
    throw new Error(gatewayErrorMessage("video submission", submit.status, submit.json));
  }
  const id = submit.json.id;
  if (!id) throw new Error(`video submission returned no id: ${JSON.stringify(submit.json)}`);
  console.log(`  request: ${id}`);
  console.log(`  status:  ${submit.json.status || "in_progress"} — polling…`);

  const interval = 3000; // a few seconds between polls, like the device-flow loop
  const deadline = Date.now() + 30 * 60 * 1000; // 30 min hard cap

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));

    const { status, json } = await getJson(`${API_BASE}/openai/v1/videos/${encodeURIComponent(id)}`, apiKey);
    if (status !== 200) throw new Error(gatewayErrorMessage("video status", status, json));

    const state = json.status;
    if (state === "completed") {
      const url = json.output?.url;
      printExpiry(json.expires_at);
      if (!url) { console.log("  Completed, but no output url in response."); return; }
      console.log(`  completed: ${url}`);
      if (output) {
        await downloadTo(url, output);
      } else {
        console.log("\n  The url is temporary. Pass --output PATH to download and keep the video.");
      }
      return;
    }
    if (state === "failed") {
      const err = json.error || {};
      const code = err.code || "generation_failed";
      console.error(`  failed: ${code}${err.message ? ` — ${err.message}` : ""}`);
      // The poll call returned HTTP 200; the failure is in the body, so the fix
      // is driven by the error code, not the (200) status.
      console.error(`\n  fix: ${suggestFix(code, null)}`);
      process.exit(1);
    }
    // queued / in_progress → keep polling.
    process.stdout.write(".");
  }

  throw new Error("Timed out waiting for the video to finish.");
}

/**
 * Show a url-expiry note. `expires_at` is account-configurable and may be absent;
 * the gateway returns it as a Unix timestamp (seconds) when present. Never hardcode
 * a duration — if it is missing we just remind the user the url is temporary.
 */
function printExpiry(expiresAt) {
  if (expiresAt != null) {
    const when = typeof expiresAt === "number" ? new Date(expiresAt * 1000).toISOString() : expiresAt;
    console.log(`  url expires: ${when}`);
  }
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
function ok(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function bad(msg) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function step(msg) { console.log(`  → ${msg}`); }
function dim(msg) { console.log(`    ${DIM}${msg}${RESET}`); }

/**
 * Map an upstream error_code (or HTTP status) to a one-line suggested fix,
 * using the skill's documented error codes.
 */
function suggestFix(code, status) {
  switch (code) {
    case "AUTHENTICATION_FAILED":
      return "Key is invalid or revoked — run `lumenfall login` or `lumenfall keys create`.";
    case "INSUFFICIENT_BALANCE":
      return "Balance too low — run `lumenfall topup` to add credits.";
    case "ALL_PROVIDERS_EXHAUSTED":
      return "Every provider failed — retry with backoff, rephrase the prompt, or try another model.";
    case "CONTENT_POLICY_VIOLATION":
      return "Prompt or output was moderated — rephrase, or force a more permissive provider.";
    case "MODEL_NOT_FOUND":
      return "Unknown model slug — list models with `lumenfall models`.";
    case "INVALID_REQUEST":
      return "Wrong endpoint or bad parameter for this model — check the model's supported modes.";
    case "INTERNAL_ERROR":
      return "Usually transient (provider or internal) — retry; if it persists, report it.";
    default:
      if (status === 401 || status === 403) return "Authentication failed — check your key.";
      if (status === 402) return "Insufficient balance — run `lumenfall topup`.";
      if (status && status >= 500) return "Server or provider error — usually transient; retry, and report it if it persists.";
      return "Inspect the request drawer at lumenfall.ai/app/requests for the full attempt chain.";
  }
}

async function cmdDoctor(requestId) {
  const c = requireCredential();

  if (requestId) {
    const { status, json } = await getJson(`${API_BASE}/v1/requests/${encodeURIComponent(requestId)}`, c.api_key);
    if (status !== 200) throw new Error(`request lookup failed (${status}): ${JSON.stringify(json)}`);
    // GET /v1/requests/:id returns the request object directly (no wrapper),
    // matching one element of the list endpoint's `data`. The metadata projection
    // (engine handlers/requests.ts formatRequestObject) does not expose `provider`,
    // so we surface `endpoint`/`modality` instead. `cost` is a dollar number paired
    // with `currency`; `duration_ms` is the response duration.
    const r = json.data || json.request || json;
    const code = r.error_code || null;
    const cost = r.cost != null ? `${r.cost} ${(r.currency || "usd").toUpperCase()}` : "—";
    console.log(`  request:  ${r.id || requestId}`);
    console.log(`  status:   ${r.status || "—"}`);
    console.log(`  model:    ${r.model || "—"}`);
    console.log(`  endpoint: ${r.endpoint || "—"}${r.modality ? ` (${r.modality})` : ""}`);
    console.log(`  created:  ${r.created_at || "—"}`);
    console.log(`  duration: ${r.duration_ms != null ? `${r.duration_ms} ms` : "—"}`);
    console.log(`  cost:     ${cost}`);
    console.log(`  error:    ${code || "—"}${r.error_message ? ` — ${r.error_message}` : ""}`);
    // The fix is driven by the request's error code, not `status` (which is the
    // 200 from this lookup call, not the failure's status).
    console.log(`\n  fix: ${suggestFix(code, null)}`);
    return;
  }

  // Health check.
  let healthy = true;

  // 1. Stored credential.
  ok(`Credential found (org ${c.organization_id}, key ${maskKey(c.api_key)}).`);

  // 2. Key authenticates + 3. gateway reachable (cheap authed call).
  let modelsStatus, modelsJson;
  try {
    ({ status: modelsStatus, json: modelsJson } = await getJson(`${API_BASE}/openai/v1/models`, c.api_key));
  } catch (e) {
    bad(`Gateway unreachable at ${API_BASE} (${e.message}).`);
    healthy = false;
    modelsStatus = 0;
  }
  if (modelsStatus === 200) {
    ok(`Gateway reachable and key authenticates (${API_BASE}).`);
  } else if (modelsStatus === 401 || modelsStatus === 403) {
    bad(`Key rejected (${modelsStatus}) — ${suggestFix("AUTHENTICATION_FAILED")}`);
    healthy = false;
  } else if (modelsStatus) {
    bad(`Gateway returned ${modelsStatus}: ${JSON.stringify(modelsJson)}`);
    healthy = false;
  }

  // 4. Balance.
  const { status: balStatus, json: balJson } = await getJson(`${API_BASE}/v1/balance`, c.api_key);
  if (balStatus === 200) {
    ok(`Balance: ${formatBalance(balJson)}`);
  } else {
    bad(`Balance check failed (${balStatus}): ${JSON.stringify(balJson)}`);
    healthy = false;
  }

  // 5. Recent failures.
  const { status: reqStatus, json: reqJson } = await getJson(`${API_BASE}/v1/requests?limit=10`, c.api_key);
  if (reqStatus === 200) {
    const requests = reqJson.data || reqJson.requests || [];
    const failures = requests.filter((r) => r.error_code || (r.status && String(r.status).toLowerCase() === "failed"));
    if (failures.length === 0) {
      ok("No recent failed requests.");
    } else {
      bad(`${failures.length} recent failure(s):`);
      // Group by error code so the fix is shown once per kind, not once per row,
      // and long upstream messages are collapsed to a single readable line.
      const groups = new Map();
      for (const f of failures) {
        const code = f.error_code || (f.status ? String(f.status) : "unknown");
        if (!groups.has(code)) groups.set(code, []);
        groups.get(code).push(f);
      }
      for (const [code, items] of groups) {
        console.log(`\n    ${code} ${DIM}×${items.length}${RESET}`);
        console.log(`    ${DIM}fix: ${suggestFix(code, null)}${RESET}`);
        for (const f of items.slice(0, 4)) {
          console.log(`      ${f.id || "?"}${f.model ? `  ${DIM}${f.model}${RESET}` : ""}`);
          if (f.error_message) console.log(`        ${DIM}${truncate(f.error_message, 72)}${RESET}`);
        }
        if (items.length > 4) console.log(`      ${DIM}… and ${items.length - 4} more${RESET}`);
      }
    }
  } else {
    bad(`Recent requests check failed (${reqStatus}): ${JSON.stringify(reqJson)}`);
  }

  console.log(
    healthy
      ? `\n  ${GREEN}All systems go.${RESET}`
      : `\n  ${RED}Issues detected — see above.${RESET}`
  );
  if (!healthy) process.exit(1);
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

const USAGE = `usage: lumenfall <command>

  Setup
    login                 device-flow sign in, mint a durable key
    print-key             print the stored key (for export LUMENFALL_API_KEY=...)
    logout                remove the local credential

  Account (uses your stored refresh token)
    whoami                show your name, email, and org
    keys list             list your API keys
    keys create <name>    mint a new durable key (shown once)
    keys revoke <id>      revoke an API key
    topup                 open the top-up / add-card page
    dashboard             open your dashboard in the browser

  Gateway (uses your stored API key)
    balance               show your prepaid balance
    models                list available model ids
    image "<prompt>"      generate an image
                            [--model M] [--size WxH] [--output PATH] [--estimate]
    video "<prompt>"      generate a video (async; polls until ready)
                            [--model M] [--size WxH] [--output PATH] [--estimate]
    estimate <image|video> "<prompt>"
                          estimate cost without generating (same as --estimate)
    doctor [request_id]   health check, or diagnose a single request`;

/**
 * Parse `generate` flags. Value flags: --model, --size, --output. Boolean
 * flags: --video (no value). Avoids parseArgs swallowing the token after a
 * boolean flag (e.g. `--video --output out.mp4`).
 */
const GENERATE_BOOLEAN_FLAGS = new Set(["video", "estimate"]);

// Parse generation args into flags AND positionals in one pass. Critically, the
// VALUE of a value-flag is consumed so it is never mistaken for a positional —
// otherwise `video --size 1280x720 "a dog"` would treat "1280x720" as the prompt
// and bill a real generation for it.
export function parseGenerate(rest) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const name = tok.slice(2);
    if (GENERATE_BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
    } else {
      flags[name] = rest[i + 1];
      i++; // consume the value so it is not read as a positional
    }
  }
  return { flags, positionals };
}

export function parseGenerateFlags(rest) {
  return parseGenerate(rest).flags;
}

async function main() {
  // Positional args: argv[0] = command, argv[1..] = positional operands.
  // (parseArgs is kept for --flag parsing; positionals are read directly.)
  const argv = process.argv.slice(2);
  const { command } = parseArgs(argv);
  const positionals = argv.slice(1).filter((a) => !a.startsWith("--"));
  switch (command) {
    case "login":
      await cmdLogin();
      break;
    case "balance": await cmdBalance(); break;
    case "whoami": await cmdWhoami(); break;
    case "keys": await cmdKeys(positionals[0], positionals[1]); break;
    case "models": await cmdModels(); break;
    case "image": { const g = parseGenerate(argv.slice(1)); await cmdImage(g.positionals[0], g.flags); break; }
    case "video": { const g = parseGenerate(argv.slice(1)); await cmdVideo(g.positionals[0], g.flags); break; }
    case "generate": { const g = parseGenerate(argv.slice(1)); await cmdGenerate(g.positionals[0], g.flags); break; }
    case "estimate": { const g = parseGenerate(argv.slice(1)); await cmdEstimate(g.positionals[0], g.positionals[1], g.flags); break; }
    case "doctor": await cmdDoctor(positionals[0]); break;
    case "topup": cmdTopup(); break;
    case "dashboard": cmdDashboard(); break;
    case "logout": cmdLogout(); break;
    case "print-key": {
      const cred = loadCredential();
      if (!cred) {
        console.error("No credentials found. Run `lumenfall login` first.");
        process.exit(1);
      }
      process.stdout.write(cred.api_key); // intentional: raw key to stdout for env-var capture
      break;
    }
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

// Only run when invoked directly — not when imported by tests or other modules.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  });
}

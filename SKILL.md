---
name: lumenfall
description: |
  Lumenfall AI media API: integration, debugging, migration, model choice, cost.
  Use ANY time the user works with Lumenfall, even without naming it. When in
  doubt, trigger.

  TRIGGER on ANY of:
  - `lmnfl_` keys or env `LUMENFALL_API_KEY`
  - `*.lumenfall.ai` URLs (api, docs, media, lumenfall.ai/app/, /models/)
  - OpenAI SDK `baseURL`/`base_url` set to a Lumenfall host
  - Generating, editing, comparing, or polling Lumenfall images/video
  - Migrating from Fal, Replicate, OpenAI, Google, OpenRouter, ImageRouter
    (incl. implicit, e.g. "port this `replicate.run` code")
  - Errors: ALL_PROVIDERS_EXHAUSTED, CONTENT_POLICY_VIOLATION, MODEL_NOT_FOUND,
    INSUFFICIENT_BALANCE, INVALID_REQUEST, AUTHENTICATION_FAILED
  - Slugs: `flux1.1-pro`, `flux.1-dev`, `gemini-3-pro-image-preview`, `seedream`
  - Model choice, arena rankings, cost (`?dryRun=true`, `metadata.cost`)

  DON'T trigger: non-Lumenfall provider work without migration intent;
  billing/sales; generic AI theory; non-Lumenfall multi-provider gateways.
---

# Lumenfall Skill

Lumenfall is a unified API for AI media generation — one API that routes to 69+ image, video,
and text models across 17+ providers (Google, OpenAI, Black Forest Labs, Replicate, fal.ai,
xAI, ByteDance, Alibaba, and others). It's OpenAI-compatible, so existing OpenAI SDK code
works by just changing the base URL.

This skill helps you write integration code, debug failures, migrate from other providers,
and pick the right model.

## Quick Orientation

### Two Base URLs

This is the most common source of confusion. Lumenfall has two URL patterns:

```
https://api.lumenfall.ai/openai/v1   ← OpenAI-compatible endpoints (images, videos, chat, models)
https://api.lumenfall.ai/v1          ← Native endpoints (requests, balance, keys)
```

OpenAI SDKs use the first one as `base_url`. The native endpoints are for account management
and debugging.

### Authentication

Every request needs a Bearer token:

```
Authorization: Bearer lmnfl_<key_id>.<secret>
```

API keys are created in the dashboard at `lumenfall.ai/app/api_keys`. They're shown only once
at creation — there is no way to retrieve them later.

### Three Modalities

**Images (synchronous):**
```
POST /openai/v1/images/generations   → returns image URLs or base64 immediately
POST /openai/v1/images/edits         → edit an existing image with a text instruction
```

**Video (asynchronous):**
```
POST /openai/v1/videos               → returns 202 with a job ID
GET  /openai/v1/videos/{id}          → poll until status is "completed" or "failed"
```

Video generation takes seconds to minutes. You must poll or set up webhooks — there's no
synchronous path.

**Text/Chat (synchronous, streaming supported):**
```
POST /openai/v1/chat/completions     → OpenAI-compatible chat (routed via OpenRouter)
```

Supports `stream: true`. Text models use OpenRouter model IDs (e.g., `google/gemini-3-flash-preview`),
while image/video models use Lumenfall slugs (e.g., `gemini-3-pro-image-preview`). Mixing these
up is a common mistake.

### Response Metadata

Every media response includes a `metadata` object with routing and cost details:

```json
{
  "metadata": {
    "model": "gemini-3-pro-image-preview",
    "provider": "vertex",
    "provider_name": "Google Vertex",
    "cost": 0.04,
    "cost_currency": "USD",
    "attempts": [...]
  }
}
```

`metadata.cost` is the effective cost in USD — always check this rather than estimating
from catalog prices, since actual cost depends on output resolution, duration, and format.

### Cost Estimation Without Execution

Append `?dryRun=true` to any generation request to get a cost estimate without actually
running the model:

```
POST /openai/v1/images/generations?dryRun=true
```

Returns `estimated: true` with a cost breakdown. Useful for budget validation in apps.

### Rate Limits

Lumenfall does not enforce rate limits. If an upstream provider rate-limits a request,
Lumenfall automatically fails over to another provider. This means transient 429 errors
from individual providers are handled transparently — the user rarely sees them.

### Forced Provider Routing

By default, Lumenfall picks the best available provider. To force a specific one, prefix
the model name:

```json
{ "model": "vertex/gemini-3-pro-image-preview" }
```

This bypasses automatic routing and sends directly to that provider. Useful for testing
or when you need deterministic provider selection — but you lose automatic failover.

## Model Discovery

Lumenfall offers several ways to discover and learn about models. When helping a user
choose a model, use these resources:

### API — Live Model List

```
GET /openai/v1/models
```

Returns the current list of all available models in OpenAI format. This is always up to
date and is the authoritative source for model slugs.

### Per-Model llms.txt — Comprehensive Model Details

Every model has a detailed plain-text profile at:

```
https://lumenfall.ai/models/{creator}/{slug}/llms.txt
```

These contain specifications, supported modes, pricing by provider, performance metrics
(p50/p95 generation times, success rates), Arena benchmarks (Elo scores, win/loss records),
category rankings, code examples, and FAQ. Fetch these when a user asks about a specific
model's capabilities, pricing, or performance.

To find the correct creator/slug for a model, check the main catalog llms.txt.

### Main Catalog llms.txt

```
https://lumenfall.ai/llms.txt
```

Lists all models with their creator organizations and links to individual model pages.
Also includes Arena leaderboard categories, blog content, and platform overview. Fetch
this when you need to browse the full catalog or find a model's creator/slug path.

### Model Advisor — Interactive Recommendations

For users who aren't sure which model to pick, point them to:

```
https://lumenfall.ai/arena/model-advisor
```

This is a chat-based model advisor that considers quality rankings, pricing, speed, and
use case fit. It has access to live Arena data and pricing.

### Arena Rankings

Lumenfall runs an Arena where models compete in blind head-to-head matchups, producing
Elo-based rankings. Rankings are available in each model's llms.txt file (see above).
Leaderboard categories include text-to-image, image editing, and text-to-video, with
sub-categories like photorealism, text rendering, illustration, and portrait.

When a user asks "what's the best model for X?", fetch the relevant model llms.txt files
to compare Arena rankings and pricing.

### Documentation

```
https://docs.lumenfall.ai/llms.txt
```

Index of all documentation pages. The full docs cover quickstart, API reference, SDK
guides, billing, routing, and more. An OpenAPI spec is available at:

```
https://docs.lumenfall.ai/api-reference/openapi.json
```

## Debugging Failed Requests

When a user reports a failed request, **don't just instruct them — diagnose for them**.
If you have access to the user's API key (env var, shell, or they share one), you should
fetch the request history yourself and walk back to them with concrete findings, not
generic steps. The fastest debugging session is one where you've already identified the
failing request before asking them anything.

If you don't have the key, the user can hand you a single `request_id` (from a thrown
error, log line, or the dashboard) and you can pull just that one. Either way, follow
the sequence below — the difference is whether you're running the curl or describing it.

### Step 1: Check the Request History API

```
GET https://api.lumenfall.ai/v1/requests?limit=10
```

Reference: https://docs.lumenfall.ai/api-reference/requests/list

This returns the user's recent requests with status, error codes, and error messages.
Filter by date range (`created_after`, `created_before`), API key (`key_id`), or status
(e.g. `status=upstream_failure` to scan only failures). Add `&summary=true` for aggregate
cost and count. To pull a specific request, use `GET /v1/requests/{request_id}`.

When the agent has the key, default to:

```
GET /v1/requests?status=upstream_failure&limit=5
```

then read the `error_code`, `error_message`, and per-attempt provider responses on the
most recent failure rather than asking the user to paste them.

Key fields in the response:
- `status`: `completed`, `upstream_failure`, `rejected`, `cancelled`
- `error_code`: machine-readable code (e.g., `ALL_PROVIDERS_EXHAUSTED`)
- `error_message`: human-readable explanation
- `cost`: effective cost in USD (even partial costs for failed requests)
- `duration_ms`: total response time

### Step 2: Link to the Dashboard

For detailed inspection, direct the user to the request drawer:

```
https://lumenfall.ai/app/requests?open={request_id}
```

Replace `{request_id}` with the actual ID (e.g., `req_2m4jLF...`). This opens the
dashboard with the request detail drawer already showing timing, provider attempts,
and error details.

### Step 3: Check Account Balance

```
GET https://api.lumenfall.ai/v1/balance
```

Returns billing type (prepaid/postpaid) and available balance. If the user is prepaid
and has a low or zero balance, that explains `INSUFFICIENT_BALANCE` errors.

### Step 4: Consult the Error Reference

Read `references/error-reference.md` in this skill for a comprehensive guide to every
error code, its real-world causes, diagnosis steps, and fixes. The reference is based on
analysis of actual production failure patterns.

## Troubleshooting Decision Tree

```
Request failed
├── error_code = CONTENT_POLICY_VIOLATION
│   └── Prompt or output flagged by provider moderation
│       ├── Try rephrasing the prompt
│       ├── Different providers have different thresholds
│       └── Forced routing to a more permissive provider may help
├── error_code = ALL_PROVIDERS_EXHAUSTED
│   └── Every provider Lumenfall tried failed
│       ├── Check error_message for the underlying provider errors
│       ├── Often transient — retry with exponential backoff
│       └── If persistent, check if the model supports the requested operation
├── error_code = INSUFFICIENT_BALANCE
│   └── Account ran out of credits
│       ├── Check balance: GET /v1/balance
│       ├── Add credits at lumenfall.ai/app/credits
│       └── Enable auto top-up to prevent this
├── error_code = INVALID_REQUEST
│   └── Something wrong with the request parameters
│       ├── Wrong modality? (edit model for generation, or vice versa)
│       ├── Prompt too long? (1000 char limit for images)
│       ├── Invalid size format? (use "WIDTHxHEIGHT" or "W:H")
│       ├── Missing required field? (image edits need an image)
│       └── Wrong Content-Type? (image edits need multipart/form-data)
├── error_code = MODEL_NOT_FOUND
│   └── Model slug doesn't match any known model
│       ├── Check slug with GET /openai/v1/models
│       ├── Common mistakes: provider prefixes (fal-ai/...), wrong versions,
│       │   wrong casing, arena display names instead of slugs
│       └── Text models need OpenRouter format: "google/gemini-3-flash-preview"
├── error_code = AUTHENTICATION_FAILED
│   └── API key is invalid, revoked, or missing
│       ├── Verify key starts with "lmnfl_"
│       ├── Check Authorization header format: "Bearer lmnfl_..."
│       └── Key may have been revoked — create a new one in the dashboard
└── error_code = UPSTREAM_ERROR
    └── A specific provider returned an error
        ├── Check error_message for provider details
        ├── Usually transient — Lumenfall should have failed over
        └── If using forced routing, the error is passed through directly
```

## Migration from Other Providers

When a user is migrating from Fal, Replicate, OpenAI, OpenRouter, ImageRouter, or direct
Google API calls to Lumenfall, read `references/migration-guide.md` for provider-specific
translation patterns, code examples, and gotchas.

The general pattern is simple: Lumenfall is OpenAI-compatible, so for most SDKs you only
need to change the base URL and API key. The migration guide covers the edge cases and
provider-specific differences that need attention.

## SDK Integration

For code examples across all supported SDKs (Python, TypeScript, Go, Ruby, Java, PHP,
Kotlin, Swift, C#, cURL), read `references/sdk-examples.md`.

The core pattern is always the same — configure an OpenAI client with Lumenfall's base URL:

```python
# Python (OpenAI SDK)
from openai import OpenAI
client = OpenAI(
    api_key="lmnfl_...",
    base_url="https://api.lumenfall.ai/openai/v1"
)
```

## Key Facts to Remember

- **No rate limits** — Lumenfall doesn't enforce them; provider rate limits trigger auto-failover
- **No markup** — pricing is pass-through from providers; no platform fee
- **Generated media is hosted on `media.lumenfall.ai`** — every image/video URL Lumenfall returns
  points there, regardless of which upstream provider rendered it. Safe to whitelist that single
  host in `next/image` or any other image proxy that needs an allowlist.
- **Media lifetime depends on the org's retention tier** — set in the dashboard at
  `lumenfall.ai/app/settings/overview` under "Data Retention". Tiers apply jointly to request
  logs *and* generated media, with three options: **Do not save** (deleted right after delivery),
  **7 days**, or **30 days**. If a user wants media to persist longer, they must download and
  re-host it to their own storage. Don't rely on the URL still resolving in your DB days later.
- **Video is always async** — POST returns 202, poll GET for completion
- **Text models vs media models** — different ID formats (OpenRouter vs Lumenfall slugs)
- **$1 free credit** for new accounts, no credit card required
- **Edit vs generate** — some models only support one mode; check the model's llms.txt
- **Provider-specific params** pass through — but may fail if routed to a different provider
- **Webhooks** use Standard Webhooks spec with HMAC-SHA256 signing
- **Serverless function timeouts** — image generation can take 30–90s on slower models, and
  video can run several minutes. On Vercel, set `export const maxDuration = 300` on App
  Router route handlers (Pro/Enterprise tiers permit longer). Don't blindly default to 60s —
  it'll cut off image generations for FLUX Pro variants and any sync video. For video you
  generally want webhooks or a polling architecture rather than a single long-running
  request.

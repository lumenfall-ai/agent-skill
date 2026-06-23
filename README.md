# Lumenfall Agent Skill

> 70+ image and video models, 17 providers, one OpenAI-compatible API. This
> skill teaches your AI coding agent how to actually use it.

[Lumenfall](https://lumenfall.ai) is a unified gateway for AI media generation.
Picking a model, debugging a failed request, migrating from Fal or Replicate,
deciding where to persist generated images. Most of that is grunt work the
docs *describe* but don't *do for you*.

This skill gives your coding agent working knowledge of how Lumenfall actually
behaves: the two base URLs people mix up, the retention model, the exact
failure modes, the forced-routing prefixes, the multipart-edit quirks. With it
loaded, your agent stops guessing and starts integrating.

Built and maintained by the [Lumenfall](https://lumenfall.ai) team. MIT
licensed.

## Who this is for

- **Developers building image or video features into a SaaS or app.** You
  want the agent to write code that fits your stack, not a generic
  hello-world.
- **Anyone migrating away from Fal, Replicate, OpenRouter, ImageRouter, or
  a direct provider API.** The skill has provider-specific before/after
  guides with working code.
- **First-time Lumenfall users.** Install the skill, ask the agent to add
  image generation to your project, get a working integration without
  reading the API reference.

## Quick start

1. Install (30 seconds, see below).
2. Ask your agent something Lumenfall-specific: *"Add image generation to
   this Next.js app, I have LUMENFALL_API_KEY in my env."*
3. Watch what it produces. If you get a route handler with the right base
   URL, a sensible model choice, and a note about media URL retention,
   the skill is working.

Stop there. You'll know if this is for you.

## Bundled CLI

The skill ships a small CLI alongside the prose. It is more than a device-login
helper: it covers the whole account and generation loop so your agent can get
you keyed in and generating without leaving the terminal. The installer puts it
on your PATH as `lumenfall`:

```bash
lumenfall <command>
```

- **Setup**: `login` (device flow, mints and stores a durable key), `print-key`
  (emit the key for `export LUMENFALL_API_KEY=...`), `logout`.
- **Account**: `whoami`, `keys list`, `keys create <name>`, `keys revoke <id>`,
  `topup`, `dashboard` (open your dashboard in the browser).
- **Generate**: `image "<prompt>"` and `video "<prompt>"`, each taking
  `--model`, `--size`, and `--output` to keep the otherwise-temporary URL.
- **Estimate**: add `--estimate` to either, or run
  `estimate <image|video> "<prompt>"`, to see the cost before you spend.
- **Ops**: `balance`, `models`, and `doctor` (a health check, or
  `doctor <request_id>` to diagnose one failed request and suggest a fix).

`generate "<prompt>"` stays a back-compat alias for `image` (and
`generate --video` for `video`).

The key lands in `~/.lumenfall/credentials.json` (chmod 600) and is only ever
shown masked, except by `print-key`. It is convenience for the account and
generation loop; production code still calls the API directly.

## Install

### Claude Code — one-liner

macOS, Linux, WSL:

```bash
curl -fsSL https://lumenfall.ai/install | sh
```

Windows (PowerShell 7+):

```powershell
irm https://lumenfall.ai/install.ps1 | iex
```

Registers the marketplace, enables the plugin (auto-updating), installs a
`lumenfall` command on your PATH, and backs up your existing
`~/.claude/settings.json` first — telling you exactly what it did. Afterward,
open a new terminal (or `source` your shell rc) so `lumenfall` is on PATH.
Inspect first with `curl -fsSL https://lumenfall.ai/install | less` if that's
your style.

### Claude Code — manual

If you'd rather not run a shell script, paste these inside Claude Code:

```
/plugin marketplace add lumenfall-ai/agent-skill
/plugin install agent-skill@lumenfall
/reload-plugins
```

The skill appears in your available-skills list and auto-triggers when you
work with Lumenfall.

### Codex CLI

Inside a Codex session:

```
$skill-installer install https://github.com/lumenfall-ai/agent-skill/tree/main/plugins/lumenfall/skills/lumenfall
```

This installs the skill into `$CODEX_HOME/skills/lumenfall` (usually
`~/.codex/skills/lumenfall`). Fully restart Codex after install so the skill
index is rebuilt. In a new session, ask:

```
do you have the lumenfall skill?
```

If it was picked up, it should appear in the available-skills list and
auto-trigger when you work with Lumenfall.

### Any other agent (one-line clone)

For Cursor, Copilot CLI, Gemini CLI, or anything else that reads the
[agentskills.io](https://agentskills.io) format but doesn't ship a
dedicated installer:

```bash
git clone --depth 1 https://github.com/lumenfall-ai/agent-skill.git \
  /tmp/lumenfall-agent-skill && \
  mkdir -p ~/.agents/skills && \
  cp -r /tmp/lumenfall-agent-skill/plugins/lumenfall/skills/lumenfall \
        ~/.agents/skills/ && \
  rm -rf /tmp/lumenfall-agent-skill
```

Above uses `~/.agents/skills/`, the open Agent Skills standard directory.
For Cursor, copy `SKILL.md` into `.cursor/rules/lumenfall.mdc` instead.
Copilot CLI and Gemini CLI: check their docs for the skills directory
they scan.

## See it work

```
You:    I'm getting ALL_PROVIDERS_EXHAUSTED on my image generation requests.
        Worked yesterday, broken today. Help?

Agent:  Two things to check first, both very common:

        1. Your base URL. If you're hitting api.lumenfall.ai/v1/images/...,
           that's wrong. Lumenfall has two URL patterns and the
           OpenAI-compatible one is /openai/v1/. Bare /v1/ is for native
           endpoints (balance, requests, keys).

        2. Your model slug. Lumenfall slugs differ from fal/Replicate
           naming. flux-pro/v1.1 is fal-style; on Lumenfall it's
           flux1.1-pro. flux/schnell is flux.1-schnell.

        Either of those match what you're seeing? If not, paste the
        request_id from your error log and I'll pull the failure
        from /v1/requests and walk back from there.

You:    The first one. Fixed the URL.

Agent:  Good. While we're here, you mentioned your storage layer. Note
        that lumenfall media URLs default to ~1h retention. If end users
        are seeing broken images later, either fetch and re-host on your
        side, or opt the org into a longer retention tier in dashboard
        settings. Want me to add the re-host pattern to your handler?
```

That conversation works because the skill knows the two-base-URL trap, the
slug naming convention, the request-history API, and the default retention
behavior. Without it, the agent would have guessed at one of those and either
been wrong or sent you back to the docs.

## What it knows

Mapped by what you're trying to do:

| When you want to... | The skill points your agent at... |
|---|---|
| Make your first request | First Run section with code shape for your stack |
| Migrate from Fal, Replicate, OpenAI, OpenRouter, ImageRouter, or Google | Provider-specific before/after migration guide |
| Debug a failed request | Error reference plus agent-side request inspection via `/v1/requests` |
| Pick a model for a use case | Model-per-use-case table, Arena pointer, Model Advisor link |
| Persist generated images past the 1h default | Storage patterns: b64_json, fetch and re-host, opt-in retention tier |
| Handle async video without a bad UX | Webhook receiver (Standard Webhooks, HMAC verify) or job-table polling |
| Cap per-user spend | `?dryRun=true` pre-flight plus `metadata.cost` accounting |
| Edit user-uploaded images | Multipart syntax, EXIF stripping, format list, multi-image gotcha |
| Decide on multi-tenant API key strategy | Key-per-tenant vs shared-key-with-user-attribution tradeoff |
| Handle CONTENT_POLICY_VIOLATION gracefully | Provider moderation strictness table, no-retry guidance |
| Force a specific upstream provider | Canonical slug list (`vertex/`, `fal/`, `openai/`, etc.) |
| Purge a request's stored payload and media | `DELETE /v1/requests/{id}/payloads` |

## Compatibility

| Agent | Status | Install path |
|---|---|---|
| Claude Code | Native plugin | `/plugin install agent-skill@lumenfall` |
| Claude.ai | Native | Upload `plugins/lumenfall/skills/lumenfall/` as a project skill |
| GitHub Copilot CLI | Native | One-line clone into the CLI's skills location |
| Gemini CLI | Native | Place under the configured skills dir; loaded via `activate_skill` |
| OpenAI Codex CLI | Native | `$skill-installer` into `$CODEX_HOME/skills/lumenfall` (usually `~/.codex/skills/lumenfall`) |
| Cursor | Portable | Copy `SKILL.md` into `.cursor/rules/lumenfall.mdc` |

Nothing in the skill body calls platform-specific tools, so any LLM-driven
agent that can read markdown can use it.

## Repo layout

```
.claude-plugin/marketplace.json             Marketplace catalog
plugins/lumenfall/
├── .claude-plugin/plugin.json              Plugin manifest
├── scripts/
│   └── lumenfall.mjs                       Bundled CLI: login,
│                                           account, ops, generation
└── skills/lumenfall/
    ├── SKILL.md                            Core skill content
    └── references/
        ├── migration-guide.md              Fal, Replicate, OpenAI,
        │                                   OpenRouter, ImageRouter, Google
        ├── error-reference.md              Every error code: cause,
        │                                   diagnosis, fix
        └── sdk-examples.md                 11 SDKs plus cURL
evals/evals.json                            Eval prompts for skill testing
```

## What this skill isn't

It's Lumenfall-specific by design, not a general AI-integration helper.
Pricing comes from the live API (`metadata.cost` and `?dryRun=true`), not
from this file. And it's media-only: embeddings, fine-tuning, assistants,
TTS, and STT aren't part of Lumenfall, so they aren't in here either.

## Links

- [Lumenfall](https://lumenfall.ai)
- [Docs](https://docs.lumenfall.ai)
- [Privacy and retention policy](https://docs.lumenfall.ai/privacy)
- [Model catalog](https://lumenfall.ai/models)
- [Get an API key](https://lumenfall.ai/app/api_keys) ($1 starter credit, no card)
- [Discord](https://discord.gg/CUPVN87u). Questions, model recs, or just say
  hi. If you're new, tell the team what you're building and they'll spot you
  a few extra dollars of credits.

## License

MIT. See [LICENSE](./LICENSE). Fork it, improve it, open a PR. The team
reads them.

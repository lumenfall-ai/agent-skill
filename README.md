# Lumenfall Skill for Claude Code

A Claude Code skill for working with the [Lumenfall](https://lumenfall.ai) AI
media API — image and video generation, model selection, debugging, and
provider migrations.

When loaded, Claude will use it automatically whenever you're working with
Lumenfall: building an integration, migrating from another provider (Fal,
Replicate, OpenAI, Google, etc.), debugging a failed request, choosing a model,
or estimating costs.

## Install

Download the latest [`lumenfall.skill`](https://github.com/lumenfall-ai/claude-skill/releases/latest)
artifact, then:

```bash
mkdir -p ~/.claude/skills/lumenfall && \
  unzip -o lumenfall.skill -d ~/.claude/skills/lumenfall
```

Restart any open Claude Code sessions to pick it up. The skill will appear in
your available-skills list as `lumenfall`.

### From source

```bash
git clone https://github.com/lumenfall-ai/claude-skill.git ~/.claude/skills/lumenfall
```

## Verify it loaded

Open a fresh Claude Code session and paste:

```
my image generation requests to api.lumenfall.ai/v1/images/generations
with model flux-pro/v1.1 are returning ALL_PROVIDERS_EXHAUSTED.
worked yesterday, broken today. help?
```

A correctly-loaded skill should catch two real bugs in that prompt: the wrong
base URL (`/v1/` should be `/openai/v1/`) and the fal-style model slug
(`flux-pro/v1.1` should be `flux1.1-pro`). It should also reference
`GET /v1/requests` for diagnosis and link to the dashboard request drawer.

If you only get a generic "ALL_PROVIDERS_EXHAUSTED means upstream failure"
answer with no Lumenfall specifics, the skill didn't trigger.

## What's in the skill

- `SKILL.md` — core integration, debugging flow, model discovery, key facts
- `references/migration-guide.md` — provider-specific translation patterns
  (Fal, Replicate, OpenAI, OpenRouter, ImageRouter, Google)
- `references/error-reference.md` — every Lumenfall error code with diagnosis
  and fixes
- `references/sdk-examples.md` — code samples for 11 SDKs + cURL

## Try it on

A few prompts that exercise different parts of the skill:

- "Migrate this `fal_client.subscribe(...)` Python code to Lumenfall."
- "Add image generation to my Next.js 14 App Router app — I have
  `LUMENFALL_API_KEY` set."
- "What's the best image model on Lumenfall for portrait photography?"
- "Estimate the cost of generating 200 product images at 1024x1024 before I
  actually run it."

## Links

- [Lumenfall](https://lumenfall.ai)
- [Lumenfall docs](https://docs.lumenfall.ai)
- [Model catalog](https://lumenfall.ai/models)
- [Get an API key](https://lumenfall.ai/app/api_keys) ($1 free credit, no card)

## License

MIT — see [LICENSE](./LICENSE) (when the standalone repo is published).

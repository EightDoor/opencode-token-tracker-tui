# opencode-token-tracker-tui

Token usage and cost tracking for [OpenCode 2](https://opencode.ai) — server-side
plugin with a compact live summary in the TUI sidebar.

[English](./README.md) | [简体中文](./README.zh-CN.md)

> Maintained by [EightDoor](https://github.com/EightDoor).
> Repository: [EightDoor/opencode-token-tracker-tui](https://github.com/EightDoor/opencode-token-tracker-tui).
> npm package: [`opencode-token-tracker-tui`](https://www.npmjs.com/package/opencode-token-tracker-tui).
> License: MIT (see [`LICENSE`](./LICENSE)).
>
> Project owner: EightDoor. All npm publishing credentials, the GitHub
> repository, the npm package, and the copyright recorded in `LICENSE` are
> held under the same owner.

## What you get

- **OpenCode 2 server plugin** — listens to `session.step.ended`,
  `session.step.failed`, and `session.status` events. Every billable step
  is appended to a local JSONL log with model, provider, tokens, cost, and
  timestamp.
- **TUI sidebar summary** — `./tui` subpath export appends a compact live
  summary to the OpenCode 2 sidebar (`sidebar.content` slot). It shows
  three lines for today / week / month (tokens, cost, messages), today's
  cache-hit rate, and the top 5 models today by cost. It does NOT touch
  the right-side content pane — your session view stays put.

## Install

The plugin package on npm is `opencode-token-tracker-tui`. OpenCode 2
auto-discovers both subpath exports from a single npm install.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-token-tracker-tui"]
}
```

Restart OpenCode and both the server-side tracking and the TUI sidebar
will activate.

## Where the data lives

| What | Path |
| --- | --- |
| Config | `~/.config/opencode/token-tracker.json` |
| Token log | `~/.config/opencode/logs/token-tracker/tokens.jsonl` |

Override via env vars: `TOKEN_TRACKER_CONFIG_FILE`, `TOKEN_TRACKER_LOG_FILE`.

Each log line is one billable step:

```json
{
  "type": "tokens",
  "sessionId": "ses_xxx",
  "messageId": "msg_xxx",
  "agent": "build",
  "model": "claude-opus-4.5",
  "provider": "github-copilot",
  "input": 1500,
  "output": 350,
  "reasoning": 0,
  "cacheRead": 5000,
  "cacheWrite": 0,
  "cost": 0.0234,
  "_ts": 1716000000000
}
```

## TUI sidebar

The TUI plugin contributes one slot: `append: "sidebar.content"`. Inside
the sidebar you get a block that looks like this:

```
Token Tracker · 3s ago
────────────────────────────────────
today       1.20M tok   $4.2130    42 msgs
week        6.40M tok  $21.4520   188 msgs
month      22.10M tok  $74.30    612 msgs

cache hit 78%
top models (today)
  1. claude-opus-4.5 $3.12 (74%)
  2. deepseek-chat   $0.55 (13%)
  3. gpt-5.2         $0.41 (10%)
  …+2 more
```

- Refreshed every `panel.refreshSeconds` (default 5s) and on every
  `session.step.ended` / `session.step.failed` event.
- `panel.enabled: false` in your config disables the sidebar without
  touching the server-side tracking.
- The plugin does NOT call `ui.panel.open` — that would replace the
  right-side content pane and clobber your session view. Appending to
  the sidebar keeps everything else visible.

## Configuration reference

```json
{
  "providers": {
    "github-copilot": { "input": 0, "output": 0 }
  },
  "models": {
    "my-custom-model": { "input": 1, "output": 2 },
    "deepseek/deepseek-v4-flash": {
      "openrouter":   { "input": 0.14, "output": 0.28, "cacheRead": 0.0028 },
      "siliconflow":  { "input": 0.2,  "output": 0.4 }
    }
  },
  "panel": {
    "enabled": true,
    "refreshSeconds": 5
  }
}
```

### Pricing fields (USD per 1M tokens)

| Field | Description |
| --- | --- |
| `input` | Prompt / input tokens |
| `output` | Completion / output tokens |
| `cacheRead` | Cached input tokens (optional) |
| `cacheWrite` | Cache write tokens (optional) |

### Pricing resolution order (first match wins)

1. `providers[<provider>]` override
2. `models[<model>]` exact match in your config
3. Built-in exact match in the maintained pricing table
4. Built-in partial match (longest key wins)
5. User `models` partial match (longest key wins)
6. Default fallback `$1` input / `$4` output per 1M tokens

Exact user config is checked before built-ins, while broad partial user
keys are checked after built-ins — so a generic `"claude"` key does not
accidentally override a precise built-in model price.

### Common scenarios

| Scenario | Override |
| --- | --- |
| Subscription (Copilot, Cursor) | Provider: `{ "input": 0, "output": 0 }` |
| Free local (Ollama, LM Studio) | Provider: `{ "input": 0, "output": 0 }` |
| Free local under paid provider | Model: `{ "input": 0, "output": 0 }` |

## Supported models (built-in pricing)

| Provider | Models |
| --- | --- |
| Anthropic | Claude Opus 4.x, Sonnet 4 / 4.5, Haiku 4 / 4.5 |
| OpenAI | GPT-5.x, GPT-4.1, GPT-4o, o1 / o3 / o4 |
| DeepSeek | deepseek-chat, deepseek-reasoner, deepseek-v4-pro |
| Google | Gemini 2.5 / 3 / 3.1 / 3.5 |

Unknown models fall back to the default pricing estimate.

## Accuracy & limitations

- **Costs are estimates** computed locally from your token logs and the
  built-in (or user-configured) pricing table. They may differ from your
  provider's official invoice when promotional credits, discounts, or
  enterprise pricing structures apply.
- **Subscription / bundled / local providers** (Copilot, Cursor, Ollama,
  LM Studio) should be configured with zero-cost overrides in your config
  file.
- **Pricing freshness**: the built-in table is manually maintained. Add
  overrides in your config where prices are stale.

## Development

```bash
git clone https://github.com/EightDoor/opencode-token-tracker-tui.git
cd opencode-token-tracker-tui
npm install
npm run build
npm test

# Real local OpenCode CLI dogfood
node scripts/real-opencode-cli-smoke.mjs --use-temporary-link --model deepseek/deepseek-chat
```

The dogfood script is repo-only (not a published npm command) and
verifies the real `opencode run` path against the local cache package
directory. It restores any temporary package links after the run.

## License

MIT © [EightDoor](https://github.com/EightDoor).

See `LICENSE` for the full text.

## Related

- [OpenCode](https://opencode.ai) — the AI coding assistant
- [OpenCode plugin docs](https://opencode.ai/docs/plugins) — how plugins
  are loaded
- [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) —
  another popular OpenCode enhancement plugin
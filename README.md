# @bevyl-ai/agent-tools

Codex threads on the [Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk), tools served in-process over MCP, and the host plumbing for [codex](https://github.com/openai/codex) agents.
Shared by
[earshot](https://github.com/Octember/earshot) and [stupify](https://github.com/Octember/stupify). Codex/exe.dev only — never the Claude API.

## What's in it

- `session.ts` — `codexThread({ tools?, model, effort, workingDirectory, … })` starts an SDK thread with the defaults every agent here wants (auto-approve, read-only sandbox, no network, secrets scrubbed from the child env). Turns are the SDK's `thread.run(input, { outputSchema, signal })`.
- `mcp.ts` — the in-process MCP host. `tools` is `(server: McpServer) => void`: register with the MCP SDK's `registerTool` and zod shapes, closures are the context, and the thread reaches them over streamable HTTP on loopback. `text()` wraps a string result.
- `rotate.ts` — codex gateway rotation for shared ChatGPT-account pools: when a turn dies on a usage
  limit, advance `~/.codex/config.toml` to the next gateway in `CODEX_GATEWAY_POOL`. See below.
- Host tools: `db-read.ts` (read-only SQLite), `ops-read.ts` (allowlisted read-only observability over
  Trigger.dev / Vercel / Datadog / Sentry / Slack).
- Integration helpers: `github.ts`, `linear.ts`, `notion.ts`, `slack.ts` — capability-style API tools where the host
  holds the tokens and the agent names allowlisted endpoints. Each is a registrar: `githubApiTool()(server)`.
- Surfaces: `surface.ts` (the `SurfaceAdapter` contract — the portability boundary between a chat surface
  and everything above it) and `slack-adapter.ts` (the Socket Mode reference implementation).
- `host.ts` — `exec` (stdin-fed subprocess), env-file parsing, a pid-based single-flight lock, clone-or-reset checkout refresh.
- `scrub-env.ts` — the default `scrubEnv`: strip secret-looking vars from what a codex child inherits.

Source-only TypeScript on `@openai/codex-sdk` and `@modelcontextprotocol/sdk`, Bun ≥ 1.3.

## Gateway rotation

Agents that run codex against a pool of interchangeable gateway accounts (e.g. exe.dev `llm` integrations,
each fronting a ChatGPT plan) can self-heal quota walls:

```ts
import { maybeRotateGateway } from '@bevyl-ai/agent-tools'

// after a codex failure you believe is a quota wall:
const r = maybeRotateGateway({ reason: errorMessage })
if (r.rotated) log(`codex gateway rotated: ${r.from} → ${r.to}`)
```

Policy lives entirely in the environment, so every consumer shares it by configuration, not code:

- `CODEX_GATEWAY_POOL` — ordered comma-separated gateway hostnames, e.g. `llm.int.exe.xyz,llm-3.int.exe.xyz,llm-4.int.exe.xyz`.
  Unset/empty → rotation is off (no-op).
- `CODEX_ROTATE_COOLDOWN_MIN` — minimum minutes between rotations (default 10). A fully-drained pool
  cycles calmly, one step per failure, instead of thrashing.

The mechanism is deliberately dumb: no probing (the real failure is the signal), no state beyond the
config file itself and a cooldown stamp next to it. A dead account fails fast and the ring advances again;
the pool converges on whichever account has quota. New codex spawns pick up the config on their next run —
no restarts.

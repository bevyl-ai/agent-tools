# @bevyl-ai/agent-tools

Shared runtime contract + generic host tools for [codex](https://github.com/openai/codex) app-server agents.
Extracted from the `@bevyl/agent-kit` packages vendored in [bunion](https://github.com/bevyl-ai/bunion) and
[earshot](https://github.com/Octember/earshot) so the two copies stop drifting. Codex/exe.dev only — never the Claude API.

## What's in it

- `AppServerSession` (`app-server.ts`) — minimal client for the codex app-server JSON-RPC stream over stdio:
  turn lifecycle, dynamic tool dispatch, token/rate-limit accounting, failure categorization.
- `rotate.ts` — codex gateway rotation for shared ChatGPT-account pools: when a turn dies on a usage
  limit, advance `~/.codex/config.toml` to the next gateway in `CODEX_GATEWAY_POOL`. See below.
- Host tools: `db-read.ts` (read-only SQLite), `ops-read.ts` (allowlisted read-only observability over
  Trigger.dev / Vercel / Datadog / Sentry / Slack).
- Integration helpers: `github.ts`, `linear.ts`, `notion.ts` — capability-style API tools where the host
  holds the tokens and the agent names allowlisted endpoints.
- Surfaces: `surface.ts` (the `SurfaceAdapter` contract — the portability boundary between a chat surface
  and everything above it) and `slack-adapter.ts` (the Socket Mode reference implementation).
- GitHub App identity: `github-app.ts` (App JWT → cached installation token) and `github-session-hooks.ts`
  (a `SessionHooks` that injects the bot token into codex sessions — child env locally, a refreshed
  token file over ssh for remote workers).
- `ssh.ts` — hardened ssh/scp helpers for driving remote worker VMs (`sshExec`, `execAsync`, `scpInto`,
  `remoteHome`, `shq`).
- `exe.ts` — the exe.dev control-plane: `exe()` (the `ssh exe.dev` CLI), integration discovery, VM naming,
  first-boot setup scripts, cron installation, repo/host validation.
- `host.ts` — runtime primitives for an agent looping on a box: `exec` (stdin-fed subprocess), env-file
  parsing, a pid-based single-flight lock, clone-or-reset checkout refresh.
- `codex-config.ts` — one writer for the keyless exe-llm gateway block in `~/.codex/config.toml`.
- `scrub-env.ts` — the default `scrubEnv`: strip secret-looking vars from what a codex child inherits.
- `types.ts` — the event/tool/config contract all of the above share.

Source-only TypeScript, no dependencies, Bun ≥ 1.3.

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

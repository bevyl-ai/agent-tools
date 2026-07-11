import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Codex gateway rotation for a shared pool of interchangeable ChatGPT accounts (e.g. exe.dev `llm`
// integrations). Which account codex uses is just the gateway HOSTNAME inside `base_url` in
// ~/.codex/config.toml, and codex re-reads that file on every spawn — so rotation is a file edit, no
// restarts. The mechanism is deliberately dumb: no probing (the caller's real failure is the signal),
// no state beyond the config file and a cooldown stamp beside it. A dead account fails fast and the
// ring advances again, so the pool converges on whichever account has quota.
//
// Policy lives in the environment so every consumer shares it by configuration, not code:
//   CODEX_GATEWAY_POOL         ordered comma-separated gateway hostnames; unset/empty = rotation off
//   CODEX_ROTATE_COOLDOWN_MIN  minimum minutes between rotations (default 10) — a fully-drained pool
//                              cycles calmly, one step per failure, instead of thrashing

// The quota-wall signatures seen from codex/the exe-llm gateway. Deliberately tight: transient network
// errors and model refusals must NOT rotate, or every hiccup walks the ring.
const QUOTA_WALL =
  /usage limit|usage_limit_reached|usageLimitExceeded|402 Payment Required|LLM credits exhausted|ChatGPT account unavailable/i

export const isQuotaWall = (text: string): boolean => QUOTA_WALL.test(text)

export type RotateResult = { rotated: true; from: string; to: string } | { rotated: false; why: string }

const defaultConfigPath = (): string => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')

/** Advance the codex gateway to the next pool entry, iff `reason` is a quota wall and the cooldown has
 *  passed. Never touches hosts outside CODEX_GATEWAY_POOL, so other providers in config.toml are safe. */
export function maybeRotateGateway(opts: { reason: string; configPath?: string; now?: number }): RotateResult {
  const pool = (process.env.CODEX_GATEWAY_POOL ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  if (pool.length < 2) return { rotated: false, why: pool.length === 0 ? 'CODEX_GATEWAY_POOL unset — rotation off' : 'pool has a single entry' }
  if (!isQuotaWall(opts.reason)) return { rotated: false, why: 'not a quota wall' }

  const configPath = opts.configPath ?? defaultConfigPath()
  if (!existsSync(configPath)) return { rotated: false, why: `no codex config at ${configPath}` }
  const config = readFileSync(configPath, 'utf8')
  const i = pool.findIndex((host) => config.includes(host))
  if (i === -1) return { rotated: false, why: 'no pool gateway in codex config' }

  const now = opts.now ?? Date.now()
  const cooldownMs = Number(process.env.CODEX_ROTATE_COOLDOWN_MIN || 10) * 60_000
  const stampPath = configPath + '.rotated-at'
  if (existsSync(stampPath)) {
    const last = Number(readFileSync(stampPath, 'utf8'))
    if (Number.isFinite(last) && now - last < cooldownMs) return { rotated: false, why: 'rotated recently — cooling down' }
  }

  const from = pool[i] as string
  const to = pool[(i + 1) % pool.length] as string
  writeFileSync(configPath, config.replaceAll(from, to))
  writeFileSync(stampPath, String(now))
  return { rotated: true, from, to }
}

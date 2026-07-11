import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shq, sshExec } from './ssh'

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

/** Where the config lives. Local by default; a consumer whose codex runs on a remote host (bunion's ssh
 *  workers) supplies read/write that shell out to that host. `read` returns null for a missing file. */
export type GatewayFs = { read(path: string): string | null; write(path: string, text: string): void }

const localFs: GatewayFs = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  write: (path, text) => writeFileSync(path, text),
}

/** A GatewayFs for a remote host's config (bunion's ssh workers): home-relative paths, and any ssh failure
 *  reads as null / no-op — an unreachable box shouldn't add its own error on top of the failure that brought
 *  us here. */
export function sshGatewayFs(host: string): GatewayFs {
  return {
    read: (path) => {
      const r = sshExec(host, `cat ${shq(path)}`, 30_000)
      return r.ok ? r.out : null
    },
    write: (path, text) => void sshExec(host, `cat > ${shq(path)}`, 30_000, text),
  }
}

const defaultConfigPath = (): string => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')

/** Advance the codex gateway to the next pool entry, iff `reason` is a quota wall and the cooldown has
 *  passed. Never touches hosts outside the pool, so other providers in config.toml are safe. `pool` and
 *  `cooldownMs` override the env for consumers that read their config from a file (stupify's config.env). */
export function maybeRotateGateway(opts: { reason: string; configPath?: string; now?: number; fs?: GatewayFs; pool?: string[]; cooldownMs?: number }): RotateResult {
  const pool = opts.pool ?? (process.env.CODEX_GATEWAY_POOL ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  if (pool.length < 2) return { rotated: false, why: pool.length === 0 ? 'CODEX_GATEWAY_POOL unset — rotation off' : 'pool has a single entry' }
  if (!isQuotaWall(opts.reason)) return { rotated: false, why: 'not a quota wall' }

  const fs = opts.fs ?? localFs
  const configPath = opts.configPath ?? defaultConfigPath()
  const config = fs.read(configPath)
  if (config === null) return { rotated: false, why: `no codex config at ${configPath}` }
  const i = pool.findIndex((host) => config.includes(host))
  if (i === -1) return { rotated: false, why: 'no pool gateway in codex config' }

  const now = opts.now ?? Date.now()
  const cooldownMs = opts.cooldownMs ?? Number(process.env.CODEX_ROTATE_COOLDOWN_MIN || 10) * 60_000
  const stampPath = configPath + '.rotated-at'
  const stamp = fs.read(stampPath)
  if (stamp !== null) {
    const last = Number(stamp)
    if (Number.isFinite(last) && now - last < cooldownMs) return { rotated: false, why: 'rotated recently — cooling down' }
  }

  const from = pool[i] as string
  const to = pool[(i + 1) % pool.length] as string
  fs.write(configPath, config.replaceAll(from, to))
  fs.write(stampPath, String(now))
  return { rotated: true, from, to }
}

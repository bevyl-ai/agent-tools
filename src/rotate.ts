import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const QUOTA_WALL =
  /usage limit|usage_limit_reached|usageLimitExceeded|402 Payment Required|LLM credits exhausted|ChatGPT account unavailable/i

export const isQuotaWall = (text: string): boolean => QUOTA_WALL.test(text)

export const isRateLimited = (out: string): boolean =>
  /payment required|credits?\s+exhausted|insufficient\s+(?:credit|quota|balance)|usage limit|rate.?limit|too many requests|\b(?:402|429)\b|quota/i.test(out)

export type RotateResult = { rotated: true; from: string; to: string } | { rotated: false; why: string }

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const defaultConfigPath = (): string => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml')

export function maybeRotateGateway(opts: { reason: string; configPath?: string; now?: number; pool?: string[]; cooldownMs?: number }): RotateResult {
  const pool = opts.pool ?? (process.env.CODEX_GATEWAY_POOL ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  if (pool.length < 2) return { rotated: false, why: pool.length === 0 ? 'CODEX_GATEWAY_POOL unset — rotation off' : 'pool has a single entry' }
  if (!isQuotaWall(opts.reason)) return { rotated: false, why: 'not a quota wall' }

  const configPath = opts.configPath ?? defaultConfigPath()
  const config = read(configPath)
  if (config === null) return { rotated: false, why: `no codex config at ${configPath}` }
  const i = pool.findIndex((host) => config.includes(host))
  if (i === -1) return { rotated: false, why: 'no pool gateway in codex config' }

  const now = opts.now ?? Date.now()
  const cooldownMs = opts.cooldownMs ?? Number(process.env.CODEX_ROTATE_COOLDOWN_MIN || 10) * 60_000
  const stampPath = configPath + '.rotated-at'
  const stamp = read(stampPath)
  if (stamp !== null) {
    const last = Number(stamp)
    if (Number.isFinite(last) && now - last < cooldownMs) return { rotated: false, why: 'rotated recently — cooling down' }
  }

  const from = pool[i] as string
  const to = pool[(i + 1) % pool.length] as string
  writeFileSync(configPath, config.replaceAll(from, to))
  writeFileSync(stampPath, String(now))
  return { rotated: true, from, to }
}

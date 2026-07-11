import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isQuotaWall, maybeRotateGateway } from './rotate'

const POOL = 'llm.int.exe.xyz,llm-3.int.exe.xyz,llm-4.int.exe.xyz'
const CONFIG = `model_provider = "exe-llm"

[model_providers.exe-llm]
name = "exe-llm"
base_url = "https://llm.int.exe.xyz/v1"
requires_openai_auth = false

[projects."/home/exedev/.stupify/repo"]
trust_level = "trusted"
`

let dir: string
let configPath: string
const savedEnv = { pool: process.env.CODEX_GATEWAY_POOL, cooldown: process.env.CODEX_ROTATE_COOLDOWN_MIN }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rotate-'))
  configPath = join(dir, 'config.toml')
  writeFileSync(configPath, CONFIG)
  process.env.CODEX_GATEWAY_POOL = POOL
  delete process.env.CODEX_ROTATE_COOLDOWN_MIN
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedEnv.pool === undefined) delete process.env.CODEX_GATEWAY_POOL
  else process.env.CODEX_GATEWAY_POOL = savedEnv.pool
  if (savedEnv.cooldown === undefined) delete process.env.CODEX_ROTATE_COOLDOWN_MIN
  else process.env.CODEX_ROTATE_COOLDOWN_MIN = savedEnv.cooldown
})

test('quota-wall signatures match, ordinary failures do not', () => {
  expect(isQuotaWall("ERROR: You've hit your usage limit. Visit https://chatgpt.com/...")).toBe(true)
  expect(isQuotaWall('usage_limit_reached')).toBe(true)
  expect(isQuotaWall('turn failed: usageLimitExceeded')).toBe(true)
  expect(isQuotaWall('402 Payment Required: LLM credits exhausted')).toBe(true)
  expect(isQuotaWall('502 Bad Gateway: ChatGPT account unavailable')).toBe(true)
  expect(isQuotaWall('stream disconnected before completion')).toBe(false)
  expect(isQuotaWall('ENOENT: codex not found')).toBe(false)
})

test('rotates to the next pool entry and stamps the cooldown', () => {
  const r = maybeRotateGateway({ reason: 'usage_limit_reached', configPath, now: 1000 })
  expect(r).toEqual({ rotated: true, from: 'llm.int.exe.xyz', to: 'llm-3.int.exe.xyz' })
  const config = readFileSync(configPath, 'utf8')
  expect(config).toContain('base_url = "https://llm-3.int.exe.xyz/v1"')
  expect(config).not.toContain('llm.int.exe.xyz')
  expect(config).toContain('trust_level = "trusted"') // rest of the file untouched
  expect(readFileSync(configPath + '.rotated-at', 'utf8')).toBe('1000')
})

test('the ring wraps: last pool entry rotates back to the first', () => {
  writeFileSync(configPath, CONFIG.replace('llm.int.exe.xyz', 'llm-4.int.exe.xyz'))
  const r = maybeRotateGateway({ reason: 'usage_limit_reached', configPath, now: 1000 })
  expect(r).toEqual({ rotated: true, from: 'llm-4.int.exe.xyz', to: 'llm.int.exe.xyz' })
})

test('cooldown suppresses back-to-back rotations, then re-arms', () => {
  expect(maybeRotateGateway({ reason: 'usage limit', configPath, now: 1000 }).rotated).toBe(true)
  expect(maybeRotateGateway({ reason: 'usage limit', configPath, now: 1000 + 9 * 60_000 })).toEqual({
    rotated: false,
    why: 'rotated recently — cooling down',
  })
  expect(maybeRotateGateway({ reason: 'usage limit', configPath, now: 1000 + 11 * 60_000 }).rotated).toBe(true)
})

test('non-quota failures never rotate', () => {
  const r = maybeRotateGateway({ reason: 'codex timed out after 30m', configPath, now: 1000 })
  expect(r).toEqual({ rotated: false, why: 'not a quota wall' })
  expect(readFileSync(configPath, 'utf8')).toBe(CONFIG)
})

test('rotation is off without a pool, or with a single-entry pool', () => {
  delete process.env.CODEX_GATEWAY_POOL
  expect(maybeRotateGateway({ reason: 'usage limit', configPath, now: 1000 }).rotated).toBe(false)
  process.env.CODEX_GATEWAY_POOL = 'llm.int.exe.xyz'
  expect(maybeRotateGateway({ reason: 'usage limit', configPath, now: 1000 }).rotated).toBe(false)
  expect(readFileSync(configPath, 'utf8')).toBe(CONFIG)
})

test('injected fs (remote worker) is used for both config and stamp', () => {
  const files: Record<string, string> = { '/remote/config.toml': CONFIG }
  const fs = { read: (p: string) => files[p] ?? null, write: (p: string, t: string) => void (files[p] = t) }
  const r = maybeRotateGateway({ reason: 'usage limit', configPath: '/remote/config.toml', now: 1000, fs })
  expect(r).toEqual({ rotated: true, from: 'llm.int.exe.xyz', to: 'llm-3.int.exe.xyz' })
  expect(files['/remote/config.toml']).toContain('llm-3.int.exe.xyz')
  expect(files['/remote/config.toml.rotated-at']).toBe('1000')
})

test('opts.pool and opts.cooldownMs override the env (config-file-driven consumers)', () => {
  delete process.env.CODEX_GATEWAY_POOL
  const pool = ['llm.int.exe.xyz', 'llm-3.int.exe.xyz']
  expect(maybeRotateGateway({ reason: 'usage limit', configPath, now: 1000, pool, cooldownMs: 5_000 })).toEqual({
    rotated: true,
    from: 'llm.int.exe.xyz',
    to: 'llm-3.int.exe.xyz',
  })
  expect(maybeRotateGateway({ reason: 'usage limit', configPath, now: 4000, pool, cooldownMs: 5_000 }).rotated).toBe(false)
  expect(maybeRotateGateway({ reason: 'usage limit', configPath, now: 7000, pool, cooldownMs: 5_000 }).rotated).toBe(true)
})

test('config pointing outside the pool is left alone', () => {
  writeFileSync(configPath, CONFIG.replace('llm.int.exe.xyz', 'llm-2.int.exe.xyz'))
  const r = maybeRotateGateway({ reason: 'usage limit', configPath, now: 1000 })
  expect(r).toEqual({ rotated: false, why: 'no pool gateway in codex config' })
})

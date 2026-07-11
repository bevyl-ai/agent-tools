import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCodexGatewayConfig } from './codex-config'
import { scrubSecrets } from './scrub-env'
import { shq } from './ssh'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-config-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('writes the exe-llm gateway block with trust entry and optional model pins', () => {
  writeCodexGatewayConfig({ codexHome: dir, gatewayHost: 'llm-4.int.exe.xyz', trustDir: '/home/x/repo', model: 'gpt-5.6-terra', reasoningEffort: 'high' })
  const toml = readFileSync(join(dir, 'config.toml'), 'utf8')
  expect(toml).toContain('model_provider = "exe-llm"')
  expect(toml).toContain('model = "gpt-5.6-terra"')
  expect(toml).toContain('model_reasoning_effort = "high"')
  expect(toml).toContain('base_url = "https://llm-4.int.exe.xyz/v1"')
  expect(toml).toContain('[projects."/home/x/repo"]')
})

test('never clobbers an existing model_provider; prepends the block above existing tables otherwise', () => {
  const file = join(dir, 'config.toml')
  writeFileSync(file, 'model_provider = "own"\n')
  writeCodexGatewayConfig({ codexHome: dir })
  expect(readFileSync(file, 'utf8')).toBe('model_provider = "own"\n')

  writeFileSync(file, '[projects."/x"]\ntrust_level = "trusted"\n')
  writeCodexGatewayConfig({ codexHome: dir })
  const toml = readFileSync(file, 'utf8')
  expect(toml.indexOf('model_provider = "exe-llm"')).toBeLessThan(toml.indexOf('[projects."/x"]'))
})

test('scrubSecrets drops secret-looking keys and keeps the rest', () => {
  const out = scrubSecrets({ SLACK_BOT_TOKEN: 'x', GITHUB_TOKEN: 'x', MY_API_KEY: 'x', DB_PASSWORD: 'x', AWS_CREDENTIALS: 'x', PATH: '/bin', HOME: '/home/x', LANG: 'en' })
  expect(Object.keys(out).sort()).toEqual(['HOME', 'LANG', 'PATH'])
})

test('shq single-quotes safely, including embedded quotes', () => {
  expect(shq('/plain/path')).toBe("'/plain/path'")
  expect(shq("it's")).toBe(`'it'\\''s'`)
})

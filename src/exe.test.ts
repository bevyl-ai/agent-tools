import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exeSetupScript, githubIntegrationFor, llmIntegrationFor, normalizeRepo, validHost, validRepo, vmNameFor } from './exe'
import { acquireLock, exec, parseEnvFile, releaseLock } from './host'

test('repo and host helpers keep shell-interpolated values tight', () => {
  expect(normalizeRepo('https://github.com/Octember/stupify.git/')).toBe('Octember/stupify')
  expect(normalizeRepo('git@github.com:Octember/stupify.git')).toBe('Octember/stupify')
  expect(validRepo('Octember/stupify')).toBe(true)
  expect(validRepo('Octember/stupify;curl bad')).toBe(false)
  expect(validHost('llm.int.exe.xyz')).toBe(true)
  expect(validHost('llm.int.exe.xyz && curl bad')).toBe(false)
  expect(vmNameFor('stupify', 'Octember/stupify')).toBe('stupify-octember-stupify')
})

test('exeSetupScript preserves the stable bun PATH bootstrap and appends codex host last', () => {
  expect(exeSetupScript('exec bunx @stupify/cli setup acme/widgets --yes', 'llm.int.exe.xyz')).toBe(
    [
      'export PATH="$HOME/.bun/bin:/usr/local/bin:$PATH"',
      'command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash',
      'export PATH="$HOME/.bun/bin:$PATH"',
      'exec bunx @stupify/cli setup acme/widgets --yes --codex-host llm.int.exe.xyz',
    ].join('\n'),
  )
})

test('exe.dev integration discovery ignores malformed optional config fields', () => {
  const runExe = (): { ok: boolean; out: string } => ({
    ok: true,
    out: JSON.stringify([
      { name: 'bad-mixed', type: 'github', config: { repositories: 123, providers: { openai: { enabled: true } } } },
      { name: 'bad-llm', type: 'llm', config: { providers: { openai: { enabled: 'yes' } } } },
      { name: 'repo-ok', type: 'github', config: { repositories: ['acme/widgets'] } },
      { name: 'llm-ok', type: 'llm', config: { providers: { openai: { enabled: true } } } },
    ]),
  })

  expect(githubIntegrationFor('acme/widgets', runExe)).toBe('repo-ok')
  expect(llmIntegrationFor(runExe)).toBe('llm-ok')
})

test('parseEnvFile strips inline comments and matched quotes; skips junk lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tools-host-'))
  try {
    const env = join(dir, 'config.env')
    writeFileSync(env, ["REPO_SLUG='acme/widgets' # comment", 'DRY_RUN=true', 'BAD LINE'].join('\n'))
    expect(parseEnvFile(env)).toEqual({ REPO_SLUG: 'acme/widgets', DRY_RUN: 'true' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the single-flight lock admits one holder, blocks a live second, releases cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-tools-lock-'))
  try {
    const lock = join(dir, 'sweep.lock')
    expect(acquireLock(lock)).toBe(true)
    expect(acquireLock(lock)).toBe(false) // our own live pid holds it
    releaseLock(lock)
    expect(acquireLock(lock)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exec folds spawn failures and timeouts into combined instead of returning empty output', () => {
  expect(exec('definitely-not-a-command-xyz', []).combined).toContain('definitely-not-a-command-xyz:')
  const echo = exec('printf', ['%s', 'hi'])
  expect(echo.ok).toBe(true)
  expect(echo.stdout).toBe('hi')
})

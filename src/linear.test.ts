import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linearGraphqlTool } from './linear'

// LINEAR_TOKEN_FILE is re-read on EVERY call: OAuth access tokens expire daily and a refresh
// timer rewrites the file — a long-lived process pinning the boot-time value goes dark at hour
// 24 (live incident, bevelina 2026-08-13).
describe('linear_graphql credential source', () => {
  const saved = { key: process.env.LINEAR_API_KEY, file: process.env.LINEAR_TOKEN_FILE }
  afterEach(() => {
    if (saved.key === undefined) delete process.env.LINEAR_API_KEY
    else process.env.LINEAR_API_KEY = saved.key
    if (saved.file === undefined) delete process.env.LINEAR_TOKEN_FILE
    else process.env.LINEAR_TOKEN_FILE = saved.file
  })

  function capture() {
    const seen: string[] = []
    const fetchFn = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers?.Authorization ?? '')
      return new Response(JSON.stringify({ data: { ok: true } }))
    }) as unknown as typeof fetch
    return { seen, tool: linearGraphqlTool(fetchFn) }
  }

  test('token file wins over the env key and is re-read per call (rotation-safe)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'linear-tok-'))
    const file = join(dir, 'token')
    writeFileSync(file, 'Bearer first-token\n')
    process.env.LINEAR_API_KEY = 'env-key'
    process.env.LINEAR_TOKEN_FILE = file
    const { seen, tool } = capture()
    await tool.run({ query: 'query { viewer { id } }' })
    writeFileSync(file, 'Bearer rotated-token\n') // the refresh timer rewrote it mid-process
    await tool.run({ query: 'query { viewer { id } }' })
    expect(seen).toEqual(['Bearer first-token', 'Bearer rotated-token'])
  })

  test('an unreadable token file falls back to LINEAR_API_KEY', async () => {
    process.env.LINEAR_API_KEY = 'env-key'
    process.env.LINEAR_TOKEN_FILE = '/nonexistent/token'
    const { seen, tool } = capture()
    const res = await tool.run({ query: 'query { viewer { id } }' })
    expect(res.success).toBe(true)
    expect(seen).toEqual(['env-key'])
  })
})

import { expect, test } from 'bun:test'
import { AppServerSession } from './app-server'
import type { CodexConfig, DynamicTool } from './types'

// msSinceLastActivity reports "active" while a host tool call is executing. These tests drive the
// real dispatch path (item/tool/call → handleToolCall) without spawning codex: the constructor
// doesn't spawn, and replies to a null proc are safe no-ops.

const CODEX: CodexConfig = {
  command: 'codex app-server',
  approvalPolicy: 'never',
  threadSandbox: 'workspace-write',
  turnSandboxPolicy: null,
  turnTimeoutMs: 600_000,
  readTimeoutMs: 30_000,
  initTimeoutMs: 60_000,
  stallTimeoutMs: 45_000,
}

// A tool whose run() the test settles by hand.
function controllableTool(name: string): { tool: DynamicTool; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const gate = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    tool: { spec: { name, description: 'test', inputSchema: {} }, run: () => gate.then(() => ({ success: true, output: 'ok' })) },
    resolve,
    reject,
  }
}

// The dispatch entrypoint is private; element-access through a narrow cast is test plumbing only.
function dispatch(s: AppServerSession, id: number, tool: string): void {
  ;(s as unknown as { handle(msg: Record<string, unknown>): void }).handle({ method: 'item/tool/call', id, params: { tool, arguments: {} } })
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0))
const FAR_FUTURE = Date.now() + 600_000

test('an in-flight host tool call counts as activity; settling it hands the clock back', async () => {
  const t = controllableTool('slow')
  const s = new AppServerSession(CODEX, [t.tool])
  expect(s.msSinceLastActivity(FAR_FUTURE)).toBeGreaterThan(0) // idle before any call

  dispatch(s, 1, 'slow')
  await settle()
  expect(s.msSinceLastActivity(FAR_FUTURE)).toBe(0) // masked while the tool runs

  t.resolve()
  await settle()
  expect(s.msSinceLastActivity(FAR_FUTURE)).toBeGreaterThan(0) // unmasked; clock runs from the reply
})

test('overlapping tool calls stay active until the last one settles', async () => {
  const a = controllableTool('a')
  const b = controllableTool('b')
  const s = new AppServerSession(CODEX, [a.tool, b.tool])

  dispatch(s, 1, 'a')
  dispatch(s, 2, 'b')
  await settle()
  a.resolve()
  await settle()
  expect(s.msSinceLastActivity(FAR_FUTURE)).toBe(0) // b still running

  b.resolve()
  await settle()
  expect(s.msSinceLastActivity(FAR_FUTURE)).toBeGreaterThan(0)
})

test('a rejecting tool run still releases the activity mask', async () => {
  const t = controllableTool('failing')
  const s = new AppServerSession(CODEX, [t.tool])

  dispatch(s, 1, 'failing')
  await settle()
  expect(s.msSinceLastActivity(FAR_FUTURE)).toBe(0)

  t.reject(new Error('boom'))
  await settle()
  expect(s.msSinceLastActivity(FAR_FUTURE)).toBeGreaterThan(0)
})

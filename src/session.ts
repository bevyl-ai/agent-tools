import { Codex, type Input, type Thread, type ThreadEvent, type ThreadOptions, type Usage } from '@openai/codex-sdk'

import { serveTools, type Tools } from './mcp'
import { scrubSecrets } from './scrub-env'

export interface ThreadConfig extends ThreadOptions {
  tools?: Tools
  env?: Record<string, string>
  codexPath?: string
}

// A codex thread with the defaults every agent here wants: auto-approve, read-only sandbox, no network, secrets
// scrubbed from the child env. Tools, if any, are the in-process MCP host. close() frees the tool route.
export async function codexThread(opts: ThreadConfig): Promise<{ thread: Thread; close: () => void }> {
  const { tools, env, codexPath, ...thread } = opts
  const served = tools ? await serveTools(tools) : null
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(scrubSecrets(process.env))) if (v !== undefined) base[k] = v
  const codex = new Codex({
    ...(codexPath ? { codexPathOverride: codexPath } : {}),
    env: { ...base, ...env },
    ...(served ? { config: { mcp_servers: { host: { url: served.url } } } } : {}),
  })
  return {
    thread: codex.startThread({ approvalPolicy: 'never', sandboxMode: 'read-only', networkAccessEnabled: false, skipGitRepoCheck: true, ...thread }),
    close: () => served?.close(),
  }
}

export interface TurnOptions {
  outputSchema?: unknown
  turnMs?: number // default 20 min
  stallMs?: number // default 5 min with no event
  onEvent?: (event: ThreadEvent) => void
}

// One turn: codex's own tool loop until its final message. Aborts on the turn timeout or a stall; a failed turn
// throws with codex's message, which is what the gateway-rotation matchers read.
export async function runTurn(thread: Thread, input: Input, opts: TurnOptions = {}): Promise<{ text: string; usage: Usage | null }> {
  const turnMs = opts.turnMs ?? 20 * 60_000
  const stallMs = opts.stallMs ?? 5 * 60_000
  const ac = new AbortController()
  const turnTimer = setTimeout(() => ac.abort(new Error(`turn timeout (${turnMs}ms)`)), turnMs)
  let stallTimer = setTimeout(() => ac.abort(new Error(`stalled (${stallMs}ms without activity)`)), stallMs)
  let text = ''
  let usage: Usage | null = null
  try {
    const { events } = await thread.runStreamed(input, { ...(opts.outputSchema === undefined ? {} : { outputSchema: opts.outputSchema }), signal: ac.signal })
    for await (const event of events) {
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => ac.abort(new Error(`stalled (${stallMs}ms without activity)`)), stallMs)
      opts.onEvent?.(event)
      if (event.type === 'item.completed' && event.item.type === 'agent_message') text = event.item.text
      if (event.type === 'turn.completed') usage = event.usage
      if (event.type === 'turn.failed') throw new Error(event.error.message)
      if (event.type === 'error') throw new Error(event.message)
    }
  } catch (e) {
    throw ac.signal.aborted ? ac.signal.reason : e
  } finally {
    clearTimeout(turnTimer)
    clearTimeout(stallTimer)
  }
  return { text, usage }
}

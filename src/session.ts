import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk'

import { serveTools, type Tools } from './mcp'
import { scrubSecrets } from './scrub-env'

export interface ThreadConfig extends ThreadOptions {
  tools?: Tools
  env?: Record<string, string>
}

export async function codexThread(opts: ThreadConfig): Promise<{ thread: Thread; close: () => void }> {
  const { tools, env, ...thread } = opts
  const served = tools ? await serveTools(tools) : null
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(scrubSecrets(process.env))) if (v !== undefined) base[k] = v
  const codex = new Codex({
    env: { ...base, ...env },
    ...(served ? { config: { mcp_servers: { host: { url: served.url } } } } : {}),
  })
  return {
    thread: codex.startThread({ approvalPolicy: 'never', sandboxMode: 'read-only', networkAccessEnabled: false, skipGitRepoCheck: true, ...thread }),
    close: () => served?.close(),
  }
}

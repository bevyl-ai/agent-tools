import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk'

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

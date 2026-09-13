import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { text } from './mcp'

const MAX_OUTPUT = 100_000

const Input = z.object({
  method: z.string().regex(/^[a-zA-Z]+(\.[a-zA-Z]+)+$/, 'Web API method, e.g. conversations.replies'),
  args: z.record(z.string(), z.unknown()).optional().describe("The method's documented arguments."),
})

// Form-encoded, not JSON: Slack only parses a JSON body on its write methods (chat.*, views.*),
// while read methods like conversations.replies ignore it and answer "missing required field".
// Every method accepts a form body; structured values (blocks, attachments) go as JSON strings.
function formBody(args: Record<string, unknown>): URLSearchParams {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    body.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return body
}

export function slackApiTool(name: string, token: string, description: string, fetchFn: typeof fetch = fetch): (server: McpServer) => void {
  const run = async ({ method, args }: z.infer<typeof Input>): Promise<string> => {
    const res = await fetchFn(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: formBody(args ?? {}),
    })
    const out = await res.text()
    if (!res.ok) throw new Error(`slack ${res.status}: ${out.slice(0, 2000)}`)
    return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n…[truncated — narrow the request]` : out
  }
  return (server) => server.registerTool(name, { description, inputSchema: Input.shape }, async (args) => text(await run(args)))
}

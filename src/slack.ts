import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { text } from './mcp'

// A Slack Web API passthrough: one method call per invocation, executed by the host with a token
// the agent never sees. Same posture as github_api/linear_graphql: the agent names the method and
// its documented arguments, the host is a thin transport. Hosts register one per credential.

const MAX_OUTPUT = 100_000

const Input = z.object({
  method: z.string().regex(/^[a-zA-Z]+(\.[a-zA-Z]+)+$/, 'Web API method, e.g. conversations.replies'),
  args: z.record(z.string(), z.unknown()).optional().describe("The method's documented arguments."),
})

export function slackApiTool(name: string, token: string, description: string, fetchFn: typeof fetch = fetch): (server: McpServer) => void {
  const run = async ({ method, args }: z.infer<typeof Input>): Promise<string> => {
    const res = await fetchFn(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(args ?? {}),
    })
    const out = await res.text()
    if (!res.ok) throw new Error(`slack ${res.status}: ${out.slice(0, 2000)}`)
    return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n…[truncated — narrow the request]` : out
  }
  return (server) => server.registerTool(name, { description, inputSchema: Input.shape }, async (args) => text(await run(args)))
}

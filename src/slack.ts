import type { DynamicTool } from './types'

// A Slack Web API passthrough: one method call per invocation, executed by the host with a token
// the agent never sees. Same posture as github_api/linear_graphql: the agent names the method and
// its documented arguments, the host is a thin transport. Hosts register one per credential.

const MAX_OUTPUT = 100_000

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['method'],
  properties: {
    method: { type: 'string', description: 'Web API method, e.g. conversations.replies' },
    args: { type: 'object', description: "The method's documented arguments." },
  },
}

export function slackApiTool(
  name: string,
  token: string,
  description: string,
  fetchFn: typeof fetch = fetch,
): DynamicTool {
  return {
    spec: { name, description, inputSchema: SCHEMA },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      const method = typeof a.method === 'string' ? a.method.trim() : ''
      if (!/^[a-zA-Z]+(\.[a-zA-Z]+)+$/.test(method)) return fail('method must look like conversations.replies')
      try {
        const res = await fetchFn(`https://slack.com/api/${method}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(a.args ?? {}),
        })
        const text = await res.text()
        if (!res.ok) return fail(`slack ${res.status}: ${text.slice(0, 2000)}`)
        return { success: true, output: text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated — narrow the request]` : text }
      } catch (e) {
        return fail(`request failed — ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

function fail(message: string): { success: false; output: string } {
  return { success: false, output: JSON.stringify({ error: { message } }, null, 2) }
}

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { text } from './mcp'

// The `github_api` host tool: one GitHub REST call per invocation, executed by the brain with its
// own token (GITHUB_TOKEN lives ONLY on the brain). The agent names method + path; the host is a
// thin, auditable transport — same posture as linear_graphql/db_read.

const MAX_OUTPUT = 100_000

// Pure validators so hosts can policy-gate and reject junk fast (unit-testable, not the security
// boundary — the token's scopes are).
export function isGithubWrite(method: string | undefined): boolean {
  return !['GET', 'HEAD', undefined, ''].includes(method?.toUpperCase?.() ?? undefined)
}

export function validateGithubPath(path: string): { path: string } | { error: string } {
  const p = path.trim()
  if (!p.startsWith('/')) return { error: 'path must start with "/" (e.g. /repos/{owner}/{repo}/pulls)' }
  if (p.includes('..') || /\s/.test(p)) return { error: 'malformed path' }
  return { path: p }
}

const Input = z.object({
  method: z.string().optional().describe('HTTP method (default GET). Writes (POST/PATCH/PUT/DELETE) may be policy-gated by the host.'),
  path: z.string().describe('REST path starting with "/", e.g. /repos/{owner}/{repo}/pulls?state=open or /search/issues?q=…'),
  body: z.record(z.string(), z.unknown()).optional().describe('JSON request body for writes.'),
})

const DESCRIPTION =
  "Call the GitHub REST API (api.github.com) with the brain's token. path starts with \"/\", query string allowed. " +
  'Examples: GET /repos/{owner}/{repo}/pulls?state=open, GET /search/issues?q=repo:owner/name+is:open+export, GET /repos/{owner}/{repo}/commits. ' +
  'Responses are JSON, truncated when huge — prefer specific endpoints and per_page over broad dumps.'

export function githubApiTool(fetchFn: typeof fetch = fetch): (server: McpServer) => void {
  const run = async ({ method, path, body }: z.infer<typeof Input>): Promise<string> => {
    const v = validateGithubPath(path)
    if ('error' in v) throw new Error(v.error)
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('not_configured: GITHUB_TOKEN is unset on this brain — if this call is essential, record it as a blocker for the operator; do not retry.')
    const res = await fetchFn(`https://api.github.com${v.path}`, {
      method: (method || 'GET').toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'bevyl-agent-kit',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`github ${res.status}: ${text.slice(0, 2000)}`)
    return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated — narrow the request]` : text
  }
  return (server) => server.registerTool('github_api', { description: DESCRIPTION, inputSchema: Input.shape }, async (args) => text(await run(args)))
}

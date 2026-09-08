import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { text } from './mcp'

// The `linear_graphql` host tool: a single raw GraphQL operation per call against Linear, executed
// by the brain with its own API key (LINEAR_API_KEY lives ONLY on the brain — the agent names an
// operation, the brain runs it). Same posture as db_read/ops_read: the credential never reaches the
// agent's workspace. One passthrough beats a hand-carved endpoint per verb: the agent composes the
// exact query it needs, and the host stays a thin, auditable transport.

const MAX_OUTPUT = 100_000 // chars returned to the agent — bounded so a wide result can't flood the turn

// Pure classifier so hosts can policy-gate writes (mutations) differently from reads. Strips leading
// comments/whitespace; a document whose first operation keyword is `mutation` is a write.
export function isLinearMutation(query: string): boolean {
  const stripped = query.replace(/^(?:\s|#[^\n]*\n?)+/, '').trim()
  return /^mutation\b/i.test(stripped)
}

const Input = z.object({
  query: z.string().min(1).describe('GraphQL query or mutation document to execute against Linear. One operation per call.'),
  variables: z.record(z.string(), z.unknown()).optional().describe('Optional GraphQL variables for the document.'),
})

const DESCRIPTION =
  'Execute a single raw GraphQL query or mutation against Linear (issues, projects, comments, teams, workflow states). ' +
  'One operation per call; a top-level `errors` array means it failed. ' +
  'Look up ids you need (team by key, state by name) with a read query before mutating. Issue identifiers look like "BEV-4128".'

export function linearGraphqlTool(fetchFn: typeof fetch = fetch): (server: McpServer) => void {
  const run = async ({ query, variables }: z.infer<typeof Input>): Promise<string> => {
    let apiKey = process.env.LINEAR_API_KEY
    // LINEAR_TOKEN_FILE wins when set: OAuth access tokens rotate on a timer (a refresh
    // service rewrites the file), so the credential is re-read on EVERY call — a long-lived
    // process must never pin a token that expired under it. Unreadable file falls back to env.
    const tokenFile = process.env.LINEAR_TOKEN_FILE
    if (tokenFile) {
      try {
        apiKey = (await readFile(tokenFile, 'utf8')).trim()
      } catch {
        /* fall back to LINEAR_API_KEY */
      }
    }
    if (!apiKey) throw new Error('not_configured: neither LINEAR_TOKEN_FILE nor LINEAR_API_KEY is usable on this brain — if this call is essential, record it as a blocker for the operator; do not retry.')
    const res = await fetchFn('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const body = (await res.json()) as { data?: unknown; errors?: unknown[] }
    if (Array.isArray(body.errors) && body.errors.length > 0) throw new Error(`linear_graphql_errors: ${JSON.stringify(body.errors).slice(0, 2000)}`)
    const out = JSON.stringify(body.data ?? null, null, 2)
    return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n…[truncated — narrow the query]` : out
  }
  return (server) => server.registerTool('linear_graphql', { description: DESCRIPTION, inputSchema: Input.shape }, async (args) => text(await run(args)))
}

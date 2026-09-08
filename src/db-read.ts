import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { text } from './mcp'

// The `db_read` host tool: READ-ONLY SQL over the production Postgres, executed by the brain as a dedicated
// SELECT-only role (`readonly_user` — SELECT grants on the public schema, no write privileges, a role-level
// statement_timeout). Same posture as ops_read/linear_graphql: the connection string lives ONLY on the brain
// (SUPABASE_READONLY_URL, via the Supavisor session pooler), never on the danger-full-access worker VMs — the agent
// names a query, the brain runs it and returns the rows. The DATABASE ROLE is the real guard (it physically cannot
// write); the checks below are defense-in-depth so a stacked or obviously-mutating statement fails fast with a clear
// message instead of a raw permission error. This exists because pit triage kept dead-ending on "can't read the DB"
// (eval scores, metering rows, a project's live state) with no way to inspect it.

const MAX_OUTPUT = 100_000 // chars of JSON returned to the agent — plenty of rows, bounded so a wide result can't flood the turn

// A read query is a SINGLE statement starting with a read verb. Strip leading comments/whitespace, forbid a second
// statement (no `select 1; delete …` stacking), and require a read-only first keyword. `readonly_user` can't write
// regardless, so this is a fast, friendly rejection — not the security boundary. Pure, so it's unit-testable.
const READ_VERBS = new Set(['select', 'with', 'explain', 'show', 'table', 'values'])

export function validateReadQuery(raw: string): { query: string } | { error: string } {
  const stripped = raw.replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '').trim()
  if (!stripped) return { error: 'empty query' }
  const oneStatement = stripped.replace(/;\s*$/, '') // a single trailing ';' is fine
  if (oneStatement.includes(';')) return { error: 'only a single statement is allowed (no "; …" stacking)' }
  const firstWord = (oneStatement.match(/^[a-z]+/i)?.[0] ?? '').toLowerCase()
  if (!READ_VERBS.has(firstWord)) return { error: `only read queries are allowed (SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES); got "${firstWord || '?'}". This tool is read-only.` }
  return { query: oneStatement }
}

// Lazy, module-scoped so the connection pool is reused across a session's turns rather than reconnecting each call.
let pool: Bun.SQL | null = null

const Input = z.object({
  query: z.string().min(1).describe('A single read-only SQL statement (SELECT / WITH / EXPLAIN / SHOW). No writes, no stacked statements.'),
})

const DESCRIPTION =
  'READ-ONLY SQL over the production Postgres, executed by the brain as a SELECT-only role (no DB credentials on this VM). ' +
  'One read statement only (SELECT / WITH / EXPLAIN / SHOW) — writes are impossible (the role has no write grants) and stacked statements are refused. ' +
  'Rows come back as JSON (capped). Use it to inspect prod data the API tools can\'t reach — eval scores, metering_events rows, a project\'s live state — instead of dead-ending on "can\'t read the DB".'

export function dbReadTool(): (server: McpServer) => void {
  const run = async ({ query }: z.infer<typeof Input>): Promise<string> => {
    const url = process.env.SUPABASE_READONLY_URL
    // Missing URL = a brain-config gap, not an agent error — say so plainly so it's reported as a blocker.
    if (!url) throw new Error('not_configured: SUPABASE_READONLY_URL is unset on this brain — if this read is essential, record it as a blocker for the operator; do not retry.')
    const v = validateReadQuery(query)
    if ('error' in v) throw new Error(v.error)
    pool ??= new Bun.SQL(url, { max: 4 })
    // A permission error here means the query tried to touch something readonly_user can't SELECT (or tried to
    // write) — it surfaces verbatim so the agent narrows the query rather than retrying blindly.
    const rows = (await pool.unsafe(v.query)) as unknown[]
    const body = JSON.stringify({ rowCount: rows.length, rows }, null, 2)
    return body.length > MAX_OUTPUT ? `${body.slice(0, MAX_OUTPUT)}\n…[truncated ${body.length - MAX_OUTPUT} of ${body.length} chars — narrow the query or add a LIMIT]` : body
  }
  return (server) => server.registerTool('db_read', { description: DESCRIPTION, inputSchema: Input.shape }, async (args) => text(await run(args)))
}

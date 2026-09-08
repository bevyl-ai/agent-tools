import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { text } from './mcp'

const MAX_OUTPUT = 100_000

const READ_VERBS = new Set(['select', 'with', 'explain', 'show', 'table', 'values'])

export function validateReadQuery(raw: string): { query: string } | { error: string } {
  const stripped = raw.replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '').trim()
  if (!stripped) return { error: 'empty query' }
  const oneStatement = stripped.replace(/;\s*$/, '')
  if (oneStatement.includes(';')) return { error: 'only a single statement is allowed (no "; …" stacking)' }
  const firstWord = (oneStatement.match(/^[a-z]+/i)?.[0] ?? '').toLowerCase()
  if (!READ_VERBS.has(firstWord)) return { error: `only read queries are allowed (SELECT / WITH / EXPLAIN / SHOW / TABLE / VALUES); got "${firstWord || '?'}". This tool is read-only.` }
  return { query: oneStatement }
}

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

    if (!url) throw new Error('not_configured: SUPABASE_READONLY_URL is unset on this brain — if this read is essential, record it as a blocker for the operator; do not retry.')
    const v = validateReadQuery(query)
    if ('error' in v) throw new Error(v.error)
    pool ??= new Bun.SQL(url, { max: 4 })

    const rows = (await pool.unsafe(v.query)) as unknown[]
    const body = JSON.stringify({ rowCount: rows.length, rows }, null, 2)
    return body.length > MAX_OUTPUT ? `${body.slice(0, MAX_OUTPUT)}\n…[truncated ${body.length - MAX_OUTPUT} of ${body.length} chars — narrow the query or add a LIMIT]` : body
  }
  return (server) => server.registerTool('db_read', { description: DESCRIPTION, inputSchema: Input.shape }, async (args) => text(await run(args)))
}

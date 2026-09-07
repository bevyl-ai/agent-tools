import { z } from 'zod'
import type { DynamicTool } from './types'

// The `notion_api` host tool: one Notion REST call per invocation, executed by the brain with its
// own integration token (NOTION_API_KEY lives ONLY on the brain). Same thin-transport posture as
// github_api/linear_graphql. Only pages/databases shared with the integration are visible.

const MAX_OUTPUT = 100_000
const NOTION_VERSION = '2022-06-28'

export function isNotionWrite(method: string | undefined): boolean {
  // Notion's search + database queries are POSTs that read — treat those paths as reads.
  return !['GET', 'HEAD', undefined, ''].includes(method?.toUpperCase?.() ?? undefined)
}

export function isNotionReadPath(method: string | undefined, path: string): boolean {
  const m = (method ?? 'GET').toUpperCase()
  if (m === 'GET' || m === 'HEAD') return true
  if (m !== 'POST') return false
  return /^\/v1\/(search|databases\/[^/]+\/query|data_sources\/[^/]+\/query)\b/.test(path.trim())
}

export function validateNotionPath(path: string): { path: string } | { error: string } {
  const p = path.trim()
  if (!p.startsWith('/v1/')) return { error: 'path must start with "/v1/" (e.g. /v1/search, /v1/pages/{id}, /v1/blocks/{id}/children)' }
  if (p.includes('..') || /\s/.test(p)) return { error: 'malformed path' }
  return { path: p }
}

const Input = z.object({
  method: z.string().optional().describe('HTTP method (default GET). POST /v1/search and database queries are reads; page/block writes may be policy-gated by the host.'),
  path: z.string().describe('Notion API path starting with "/v1/", e.g. /v1/search, /v1/pages/{id}, /v1/blocks/{id}/children?page_size=50'),
  body: z.record(z.string(), z.unknown()).optional().describe('JSON request body (e.g. { query: "roadmap" } for search).'),
})

const DESCRIPTION =
  "Call the Notion API (api.notion.com) with the brain's integration token. " +
  'Find things: POST /v1/search with { query }. Read a page: GET /v1/pages/{id} for properties, GET /v1/blocks/{id}/children for content. ' +
  'Only pages shared with the integration are visible. Responses truncated when huge.'

export function notionApiTool(fetchFn: typeof fetch = fetch): DynamicTool<z.infer<typeof Input>, string> {
  return {
    name: 'notion_api',
    description: DESCRIPTION,
    input: Input,
    async run({ method, path, body }) {
      const v = validateNotionPath(path)
      if ('error' in v) throw new Error(v.error)
      const token = process.env.NOTION_API_KEY
      if (!token) throw new Error('not_configured: NOTION_API_KEY is unset on this brain — if this call is essential, record it as a blocker for the operator; do not retry.')
      const res = await fetchFn(`https://api.notion.com${v.path}`, {
        method: (method || 'GET').toUpperCase(),
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`notion ${res.status}: ${text.slice(0, 2000)}`)
      return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated — narrow the request]` : text
    },
  }
}

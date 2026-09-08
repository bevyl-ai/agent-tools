import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { text } from './mcp'

const MAX_OUTPUT = 100_000

interface OpsService {
  base(): string
  auth(): Record<string, string> | null
  envHint: string
  allow: [method: string, prefix: string][]
}

const SERVICES: Record<string, OpsService> = {
  trigger: {
    base: () => 'https://api.trigger.dev',
    auth: () => (process.env.TRIGGER_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.TRIGGER_ACCESS_TOKEN}` } : null),
    envHint: 'TRIGGER_ACCESS_TOKEN',
    allow: [
      ['GET', '/api/v1/runs'],
      ['GET', '/api/v3/runs'],
      ['GET', '/api/v1/projects'],
      ['GET', '/api/v1/deployments'],
    ],
  },
  vercel: {
    base: () => 'https://api.vercel.com',
    auth: () => (process.env.VERCEL_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.VERCEL_ACCESS_TOKEN}` } : null),
    envHint: 'VERCEL_ACCESS_TOKEN',

    allow: [
      ['GET', '/v6/deployments'],
      ['GET', '/v13/deployments'],
      ['GET', '/v3/deployments'],
    ],
  },
  datadog: {
    base: () => `https://api.${process.env.DD_SITE || 'datadoghq.com'}`,
    auth: () => {

      const api = process.env.DATADOG_API_KEY || process.env.DD_API_KEY
      const app = process.env.DATADOG_APPLICATION_KEY || process.env.DD_APPLICATION_KEY || process.env.DD_APP_KEY
      return api && app ? { 'dd-api-key': api, 'dd-application-key': app } : null
    },
    envHint: 'DATADOG_API_KEY + DATADOG_APPLICATION_KEY',
    allow: [
      ['GET', '/api/v1/monitor'],
      ['GET', '/api/v1/dashboard'],
      ['POST', '/api/v2/logs/events/search'],
    ],
  },
  slack: {

    base: () => 'https://slack.com',
    auth: () => (process.env.SLACK_BOT_TOKEN ? { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } : null),
    envHint: 'SLACK_BOT_TOKEN',
    allow: [
      ['GET', '/api/conversations.replies'],
      ['GET', '/api/conversations.history'],
      ['GET', '/api/users.info'],
    ],
  },
  sentry: {

    base: () => 'https://sentry.io',
    auth: () => {
      const t = process.env.SENTRY_PERSONAL_API_KEY || process.env.SENTRY_AUTH_TOKEN
      return t ? { authorization: `Bearer ${t}` } : null
    },
    envHint: 'SENTRY_PERSONAL_API_KEY',
    allow: [
      ['GET', '/api/0/projects'],
      ['GET', '/api/0/organizations'],
    ],
  },
}

export function resolveOpsRequest(service: string, method: string, path: string): { url: string } | { error: string } {
  const svc = SERVICES[service]
  if (!svc) return { error: `unknown_service: ${service} — one of: ${Object.keys(SERVICES).join(', ')}` }

  if (!path.startsWith('/') || /^\/[/\\]/.test(path)) return { error: 'invalid_path: must be an absolute path like /api/v1/runs' }
  let url: URL
  try {
    url = new URL(path, svc.base())
  } catch {
    return { error: `invalid_path: ${path}` }
  }
  if (url.origin !== new URL(svc.base()).origin) return { error: 'invalid_path: must stay on the service API host' }

  const m = method.toUpperCase()
  const ok = svc.allow.some(([am, prefix]) => am === m && (url.pathname === prefix || url.pathname.startsWith(prefix + '/')))
  if (!ok) {
    const allowed = svc.allow.map(([am, prefix]) => `${am} ${prefix}`).join(', ')
    return { error: `refused: ${m} ${url.pathname} is not on the ${service} READ allowlist. This tool is read-only; allowed: ${allowed} (each also matches subpaths).` }
  }

  if (service === 'vercel' && process.env.VERCEL_TEAM_ID && !url.searchParams.has('teamId')) url.searchParams.set('teamId', process.env.VERCEL_TEAM_ID)
  return { url: url.toString() }
}

function describe(): string {
  const refs = [
    process.env.TRIGGER_FAST_PROJECT_REF ? `fast=${process.env.TRIGGER_FAST_PROJECT_REF}` : null,
    process.env.BACKEND_TASKS_TRIGGER_PROJECT_REF ? `backend-tasks=${process.env.BACKEND_TASKS_TRIGGER_PROJECT_REF}` : null,
  ].filter(Boolean)
  return (
    'READ-ONLY observability over production systems, executed by the brain (no credentials exist on this VM). ' +
    'Only allowlisted read endpoints run; everything else is refused:\n' +
    `• trigger (api.trigger.dev): GET /api/v1/runs (list), /api/v3/runs/:runId (one run: status/attempts/error), /api/v1/projects/:projectRef/runs, /api/v1/deployments/:id.${refs.length ? ` Project refs: ${refs.join(', ')}.` : ''}\n` +
    `• vercel (api.vercel.com): GET /v6/deployments (list — filter ?projectId=…), /v13/deployments/:idOrUrl (one deployment incl. build state), /v3/deployments/:idOrUrl/events (build logs). teamId is appended for you.${process.env.VERCEL_PROJECT_ID ? ` Project id: ${process.env.VERCEL_PROJECT_ID}.` : ''}\n` +
    '• datadog: GET /api/v1/monitor (+/:id), /api/v1/dashboard (+/:id); POST /api/v2/logs/events/search with { body } (log search — the only POST allowed).\n' +
    '• sentry (sentry.io): GET /api/0/projects/:org/:project/(rules|issues|events) and /api/0/organizations/:org/(projects|integrations) — alert rules, issues, and project/org config (e.g. why an error did not page).\n' +
    '• slack (slack.com): GET /api/conversations.replies?channel=C…&ts=… (a thread — from a permalink /archives/C…/p1234567890123456, the ts is those digits with a dot before the last 6), /api/conversations.history?channel=C…, /api/users.info?user=U…. Read the Slack threads tickets cite as evidence.\n' +
    "Use it to diagnose a failed prod Trigger run, see why a Vercel preview didn't build, read Datadog monitors/logs, or check Sentry alert rules — instead of dead-ending on \"can't inspect prod\"."
  )
}

const Input = z.object({
  service: z.enum(['trigger', 'vercel', 'datadog', 'sentry', 'slack']).describe('Which system to read.'),
  path: z.string().min(1).describe('Absolute API path incl. query string, e.g. /v6/deployments?projectId=…'),
  method: z.enum(['GET', 'POST']).default('GET').describe('Default GET. POST only for the datadog log search endpoint.'),
  body: z.record(z.string(), z.unknown()).optional().describe('(POST only) JSON request body, e.g. { filter: { query, from, to } }.'),
})

export function opsReadTool(): (server: McpServer) => void {
  const run = async ({ service, path, method, body }: z.infer<typeof Input>): Promise<string> => {
    const svc = SERVICES[service]!
    const headers = svc.auth()

    if (!headers) throw new Error(`not_configured: ${service} is not configured on this brain (${svc.envHint} unset) — if this read is essential, record it as a blocker for the operator; do not retry.`)
    const req = resolveOpsRequest(service, method, path.trim())
    if ('error' in req) throw new Error(req.error)
    const payload = method === 'POST' && body ? JSON.stringify(body) : undefined

    const res = await fetch(req.url, { method, headers: payload ? { ...headers, 'content-type': 'application/json' } : headers, ...(payload ? { body: payload } : {}), signal: AbortSignal.timeout(30_000) })
    const text = await res.text()
    const out = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} of ${text.length} chars — narrow the query]` : text
    if (!res.ok) throw new Error(`HTTP ${res.status}\n${out}`)
    return `HTTP ${res.status}\n${out}`
  }
  return (server) => server.registerTool('ops_read', { description: describe(), inputSchema: Input.shape }, async (args) => text(await run(args)))
}

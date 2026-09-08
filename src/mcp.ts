import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

export type Tools = (server: McpServer) => void

export const text = (s: string): { content: { type: 'text'; text: string }[] } => ({ content: [{ type: 'text', text: s }] })

const routes = new Map<string, WebStandardStreamableHTTPServerTransport>()
let host: ReturnType<typeof Bun.serve> | null = null

const unref = (server: ReturnType<typeof Bun.serve>): ReturnType<typeof Bun.serve> => {
  server.unref()
  return server
}

export async function serveTools(register: Tools): Promise<{ url: string; close: () => void }> {
  host ??= unref(Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => routes.get(new URL(req.url).pathname)?.handleRequest(req) ?? new Response('not found', { status: 404 }),
  }))
  const path = `/${crypto.randomUUID()}`
  const server = new McpServer({ name: 'host', version: '0' })
  register(server)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true })
  await server.connect(transport)
  routes.set(path, transport)
  return {
    url: `http://127.0.0.1:${host.port}${path}`,
    close: () => {
      routes.delete(path)
      void server.close()
    },
  }
}

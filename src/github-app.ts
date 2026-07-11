import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Mint a GitHub App installation token so an agent commits + opens PRs as its own bot identity
// (e.g. bevyl-dark-factory[bot]) instead of the operator's personal account. Server-to-server only: sign a
// short App JWT with the app's private key, exchange it for a 60-min installation token — no OAuth, no user
// in the loop. Tokens are cached per app and re-minted before expiry, so per-session/per-git-op calls are cheap.
export interface GithubAppConfig {
  appId: string
  installationId: string
  privateKeyPath: string // path to the app's .pem on the daemon host
  botName: string // git author name, e.g. "bevyl-dark-factory[bot]"
  botEmail: string // git author email, e.g. "<bot-user-id>+bevyl-dark-factory[bot]@users.noreply.github.com"
}

const cache = new Map<string, { token: string; expiresMs: number }>()

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// A signed App JWT (RS256), valid ~9 min. `iat` is backdated 60s to tolerate clock skew (GitHub's guidance).
function appJwt(appId: string, privateKeyPath: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = b64url(Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })))
  const sig = b64url(createSign('RSA-SHA256').update(`${header}.${payload}`).sign(readFileSync(privateKeyPath, 'utf8')))
  return `${header}.${payload}.${sig}`
}

// The current installation token for the app, or null when no github app is configured. Returns a cached
// token while it has more than `refreshWindowMs` of life; otherwise mints a fresh one. Throws on a real mint
// failure (bad key/perms) so the caller surfaces it rather than silently falling back to the operator identity.
export async function githubAppToken(app: GithubAppConfig | null | undefined, nowMs: number = Date.now(), refreshWindowMs = 600_000): Promise<string | null> {
  if (!app) return null
  const key = `${app.appId}:${app.installationId}`
  const cached = cache.get(key)
  if (cached && cached.expiresMs - nowMs > refreshWindowMs) return cached.token

  const jwt = appJwt(app.appId, app.privateKeyPath, nowMs)
  const res = await fetch(`https://api.github.com/app/installations/${app.installationId}/access_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`github app token mint failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { token: string; expires_at: string }
  cache.set(key, { token: body.token, expiresMs: Date.parse(body.expires_at) })
  return body.token
}

import type { SessionHooks } from './app-server'
import { githubAppToken, type GithubAppConfig } from './github-app'
import { shq, sshExec } from './ssh'
import type { AgentEvent } from './types'

// AppServerSession is credential-agnostic; this hook injects a GitHub App bot identity. Remote (VM) session →
// write the GH_TOKEN file the VM's ~/.profile exports (codex scrubs env, so a file is the only way to reach the
// agent's shells) and keep it fresh; local session → return GH_TOKEN in the child env. null app config → no
// hook, so agents fall back to the ambient gh/git identity. `tokenFilePath` is the consumer's home-relative
// file its VM ~/.profile reads (bunion: ~/.bunion/gh-token).
export interface GithubHooksOptions {
  tokenFilePath: string
  onEvent?: (e: AgentEvent) => void
}

export function githubSessionHooks(app: GithubAppConfig | null | undefined, opts: GithubHooksOptions): SessionHooks | undefined {
  if (!app) return undefined
  const onEvent = opts.onEvent ?? (() => {})
  return {
    async beforeSpawn(host) {
      if (host) {
        const r = await writeGithubTokenFile(app, host, opts.tokenFilePath, onEvent)
        if (!r.ok) throw new Error(`write github token on ${host}: ${r.error || 'failed'}`)
        return
      }
      const token = (await githubAppToken(app)) ?? ''
      return token ? { env: { GH_TOKEN: token } } : undefined
    },
    afterStart(host) {
      return startGithubTokenFileRefresh(app, host, opts.tokenFilePath, onEvent)
    },
  }
}

export const GH_TOKEN_FILE_REFRESH_MS = 30 * 60_000
export const GH_TOKEN_FILE_REFRESH_WINDOW_MS = 35 * 60_000

type TimerHandle = ReturnType<typeof setInterval>

interface Deps {
  token(app: GithubAppConfig, refreshWindowMs: number): Promise<string | null>
  sshExec(host: string, command: string, timeoutMs?: number): { ok: boolean; out: string }
  setInterval(fn: () => void, ms: number): TimerHandle
  clearInterval(timer: TimerHandle): void
}

const defaultDeps: Deps = {
  token: (app, refreshWindowMs) => githubAppToken(app, Date.now(), refreshWindowMs),
  sshExec,
  setInterval,
  clearInterval,
}

export function githubTokenFileCommand(token: string, tokenFilePath: string): string {
  // The path is deliberately NOT shq-quoted: it's home-relative ("~/.bunion/gh-token") and quoting the ~
  // would kill tilde expansion on the remote. Validate instead — it's config, but a typo'd path with shell
  // metacharacters must fail loudly here, not become a remote injection.
  if (!/^[A-Za-z0-9_~./-]+$/.test(tokenFilePath) || tokenFilePath.includes('..')) throw new Error(`unsafe github token file path: ${tokenFilePath}`)
  const dir = tokenFilePath.split('/').slice(0, -1).join('/')
  return `umask 077 && mkdir -p ${dir} && printf %s ${shq(token)} > ${tokenFilePath}`
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function report(onEvent: (e: AgentEvent) => void, host: string, message: string): void {
  onEvent({ log: `github token refresh failed host=${host}: ${message}` })
}

export async function writeGithubTokenFile(
  app: GithubAppConfig | null | undefined,
  host: string | null,
  tokenFilePath: string,
  onEvent: (e: AgentEvent) => void = () => {},
  deps: Deps = defaultDeps,
): Promise<{ ok: boolean; wrote: boolean; error?: string }> {
  if (!app || !host) return { ok: true, wrote: false }
  try {
    const token = await deps.token(app, GH_TOKEN_FILE_REFRESH_WINDOW_MS)
    if (!token) return { ok: true, wrote: false }
    const r = deps.sshExec(host, githubTokenFileCommand(token, tokenFilePath), 30_000)
    if (!r.ok) {
      const error = r.out.trim().slice(-300) || 'ssh command failed'
      report(onEvent, host, error)
      return { ok: false, wrote: false, error }
    }
    return { ok: true, wrote: true }
  } catch (e) {
    const error = errText(e)
    report(onEvent, host, error)
    return { ok: false, wrote: false, error }
  }
}

export function startGithubTokenFileRefresh(
  app: GithubAppConfig | null | undefined,
  host: string | null,
  tokenFilePath: string,
  onEvent: (e: AgentEvent) => void = () => {},
  deps: Deps = defaultDeps,
): () => void {
  if (!app || !host) return () => {}
  let inFlight = false
  const tick = (): void => {
    if (inFlight) return
    inFlight = true
    void writeGithubTokenFile(app, host, tokenFilePath, onEvent, deps).finally(() => {
      inFlight = false
    })
  }
  const timer = deps.setInterval(tick, GH_TOKEN_FILE_REFRESH_MS)
  return () => deps.clearInterval(timer)
}

import { githubAppToken, type GithubAppConfig } from './github-app'
import { shq, sshExec } from './ssh'

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

function report(log: (message: string) => void, host: string, message: string): void {
  log(`github token refresh failed host=${host}: ${message}`)
}

export async function writeGithubTokenFile(
  app: GithubAppConfig | null | undefined,
  host: string | null,
  tokenFilePath: string,
  log: (message: string) => void = () => {},
  deps: Deps = defaultDeps,
): Promise<{ ok: boolean; wrote: boolean; error?: string }> {
  if (!app || !host) return { ok: true, wrote: false }
  try {
    const token = await deps.token(app, GH_TOKEN_FILE_REFRESH_WINDOW_MS)
    if (!token) return { ok: true, wrote: false }
    const r = deps.sshExec(host, githubTokenFileCommand(token, tokenFilePath), 30_000)
    if (!r.ok) {
      const error = r.out.trim().slice(-300) || 'ssh command failed'
      report(log, host, error)
      return { ok: false, wrote: false, error }
    }
    return { ok: true, wrote: true }
  } catch (e) {
    const error = errText(e)
    report(log, host, error)
    return { ok: false, wrote: false, error }
  }
}

export function startGithubTokenFileRefresh(
  app: GithubAppConfig | null | undefined,
  host: string | null,
  tokenFilePath: string,
  log: (message: string) => void = () => {},
  deps: Deps = defaultDeps,
): () => void {
  if (!app || !host) return () => {}
  let inFlight = false
  const tick = (): void => {
    if (inFlight) return
    inFlight = true
    void writeGithubTokenFile(app, host, tokenFilePath, log, deps).finally(() => {
      inFlight = false
    })
  }
  const timer = deps.setInterval(tick, GH_TOKEN_FILE_REFRESH_MS)
  return () => deps.clearInterval(timer)
}

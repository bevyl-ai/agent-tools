// Host-runtime primitives for an agent looping on a box: synchronous subprocess exec (stdin-fed to
// dodge ARG_MAX), env-file parsing, a pid-based single-flight lock, and clone-or-reset checkout refresh.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ProcResult {
  ok: boolean
  stdout: string
  combined: string
}

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  input?: string
}

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): ProcResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input ?? '',
    timeout: opts.timeoutMs,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = r.stdout ?? ''
  let combined = stdout + (r.stderr ?? '')
  if (r.signal) combined += `\n${cmd}: process killed by ${r.signal}${opts.timeoutMs ? ` (timeout ${opts.timeoutMs}ms)` : ''}`
  if (r.error) combined += `\n${cmd}: ${r.error.message}`
  return { ok: r.status === 0 && r.error === undefined, stdout, combined }
}

export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1)
    const comment = value.indexOf(' #')
    let v = (comment < 0 ? value : value.slice(0, comment)).trim()
    if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v.at(-1) === v[0]) v = v.slice(1, -1)
    out[key] = v
  }
  return out
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function acquireLock(path: string, opts: { staleMs?: number } = {}): boolean {
  const staleMs = opts.staleMs ?? 6 * 60 * 60_000
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    try {
      const holder = Number(readFileSync(path, 'utf8').trim())
      if (!pidAlive(holder) || Date.now() - statSync(path).mtimeMs > staleMs) {
        writeFileSync(path, String(process.pid))
        return true
      }
    } catch {
      /* lock vanished or became unreadable; let the next tick retry */
    }
    return false
  }
}

export function releaseLock(path: string): void {
  try {
    if (Number(readFileSync(path, 'utf8').trim()) === process.pid) rmSync(path, { force: true })
  } catch {
    /* best-effort */
  }
}

export function refreshCheckout(opts: { repoDir: string; slug: string; defaultBranch: string; log?: (message: string) => void }): boolean {
  mkdirSync(dirname(opts.repoDir), { recursive: true })
  if (!existsSync(join(opts.repoDir, '.git'))) {
    opts.log?.(`cloning ${opts.slug} -> ${opts.repoDir}`)
    if (!exec('gh', ['repo', 'clone', opts.slug, opts.repoDir, '--', '-q']).ok) return false
  }
  const branch = opts.defaultBranch
  return (
    exec('git', ['fetch', '-q', 'origin', branch], { cwd: opts.repoDir }).ok &&
    exec('git', ['checkout', '-q', branch], { cwd: opts.repoDir }).ok &&
    exec('git', ['reset', '-q', '--hard', `origin/${branch}`], { cwd: opts.repoDir }).ok
  )
}

export function have(cmd: string): boolean {
  return Bun.which(cmd) !== null
}

import { expect, test } from 'bun:test'
import {
  GH_TOKEN_FILE_REFRESH_MS,
  GH_TOKEN_FILE_REFRESH_WINDOW_MS,
  githubTokenFileCommand,
  startGithubTokenFileRefresh,
  writeGithubTokenFile,
} from './github-session-hooks'
import type { GithubAppConfig } from './github-app'
import type { AgentEvent } from './types'

const app: GithubAppConfig = {
  appId: '1',
  installationId: '2',
  privateKeyPath: '/tmp/key.pem',
  botName: 'bevyl-dark-factory[bot]',
  botEmail: 'bot@example.com',
}
const PATH = '~/.bunion/gh-token'

test('githubTokenFileCommand writes the worker token file with shell quoting, tilde left bare', () => {
  expect(githubTokenFileCommand("tok'en", PATH)).toBe("umask 077 && mkdir -p ~/.bunion && printf %s 'tok'\\''en' > ~/.bunion/gh-token")
  expect(() => githubTokenFileCommand('t', '~/x; rm -rf /')).toThrow('unsafe github token file path')
  expect(() => githubTokenFileCommand('t', '~/../etc/x')).toThrow('unsafe github token file path')
})

test('writeGithubTokenFile mints with a wide refresh window and writes over ssh', async () => {
  const calls: unknown[][] = []
  const result = await writeGithubTokenFile(app, 'worker.example', PATH, () => {}, {
    token: async (...args) => {
      calls.push(args)
      return 'fresh-token'
    },
    sshExec: (...args) => {
      calls.push(args)
      return { ok: true, out: '' }
    },
    setInterval,
    clearInterval,
  })

  expect(result).toEqual({ ok: true, wrote: true })
  expect(calls[0]).toEqual([app, GH_TOKEN_FILE_REFRESH_WINDOW_MS])
  expect(calls[1]).toEqual(['worker.example', "umask 077 && mkdir -p ~/.bunion && printf %s 'fresh-token' > ~/.bunion/gh-token", 30_000])
})

test('refresh window exceeds refresh cadence so cached startup tokens cannot expire before refresh', () => {
  expect(GH_TOKEN_FILE_REFRESH_WINDOW_MS).toBeGreaterThan(GH_TOKEN_FILE_REFRESH_MS)
})

test('writeGithubTokenFile is a no-op without a remote host or github app', async () => {
  let tokenCalls = 0
  const deps = {
    token: async () => {
      tokenCalls++
      return 'fresh-token'
    },
    sshExec: () => ({ ok: true, out: '' }),
    setInterval,
    clearInterval,
  }

  await expect(writeGithubTokenFile(app, null, PATH, () => {}, deps)).resolves.toEqual({ ok: true, wrote: false })
  await expect(writeGithubTokenFile(null, 'worker.example', PATH, () => {}, deps)).resolves.toEqual({ ok: true, wrote: false })
  expect(tokenCalls).toBe(0)
})

test('writeGithubTokenFile reports refresh failures without throwing', async () => {
  const events: AgentEvent[] = []
  const result = await writeGithubTokenFile(app, 'worker.example', PATH, (e) => events.push(e), {
    token: async () => 'fresh-token',
    sshExec: () => ({ ok: false, out: 'permission denied' }),
    setInterval,
    clearInterval,
  })

  expect(result).toEqual({ ok: false, wrote: false, error: 'permission denied' })
  expect(events[0]?.log).toContain('github token refresh failed host=worker.example')
  expect(events[0]?.log).toContain('permission denied')
})

test('startGithubTokenFileRefresh schedules periodic token-file writes', async () => {
  let tick: () => void = () => {
    throw new Error('interval was not scheduled')
  }
  let intervalMs = 0
  let cleared = false
  const calls: string[] = []
  const stop = startGithubTokenFileRefresh(app, 'worker.example', PATH, () => {}, {
    token: async () => 'fresh-token',
    sshExec: (host) => {
      calls.push(host)
      return { ok: true, out: '' }
    },
    setInterval: (fn, ms) => {
      tick = fn
      intervalMs = ms
      return {} as ReturnType<typeof setInterval>
    },
    clearInterval: () => {
      cleared = true
    },
  })

  expect(intervalMs).toBe(GH_TOKEN_FILE_REFRESH_MS)
  tick()
  await Bun.sleep(0)
  expect(calls).toEqual(['worker.example'])
  stop()
  expect(cleared).toBe(true)
})

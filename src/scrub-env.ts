// Strip secret-looking env vars from what a codex child inherits — otherwise a prompt-injected turn could
// `echo $SLACK_BOT_TOKEN` and exfiltrate credentials. The default implementation for AppServerSession's
// scrubEnv hook: a single-process host (earshot) keeps secrets in its own env and hands the child a scrubbed
// copy. Hosts that never pass secrets at all (bunion's remote workers) don't need this.
export const SECRET_ENV = /token|secret|password|(api|application|access|private)[_-]?key|credential/i

export function scrubSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v
  return out
}

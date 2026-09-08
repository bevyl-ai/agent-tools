export const SECRET_ENV = /token|secret|password|(api|application|access|private)[_-]?key|credential/i

export function scrubSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v
  return out
}

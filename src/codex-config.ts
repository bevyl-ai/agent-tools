import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Point codex at a keyless exe-llm gateway (`https://<host>.int.exe.xyz/v1` — the integration fronts a
// ChatGPT plan, so the box needs no OpenAI key). One writer for the block that bunion's and tag's
// vm-setup.sh used to heredoc and stupify's CLI wrote in TS; rotate.ts later rewrites the same base_url.
// Idempotent and non-clobbering: if config.toml already names a model_provider it is left alone entirely —
// codex writes its own project-trust entries into this file between runs, and re-provisioning must not
// fight them. Top-level keys must precede any [table], so the block is PREPENDED to existing content.
export interface CodexGatewayOptions {
  gatewayHost?: string // default llm.int.exe.xyz
  codexHome?: string // default $CODEX_HOME or ~/.codex
  trustDir?: string // optional [projects] trust entry so `codex exec` runs there without prompting
  model?: string // optional pinned model (`model = "…"`)
  reasoningEffort?: string // optional `model_reasoning_effort`
}

export function writeCodexGatewayConfig(opts: CodexGatewayOptions = {}): void {
  const dir = opts.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const file = join(dir, 'config.toml')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (existing.includes('model_provider')) return
  mkdirSync(dir, { recursive: true })
  const gatewayHost = opts.gatewayHost ?? 'llm.int.exe.xyz'
  const top = [
    'model_provider = "exe-llm"',
    ...(opts.model ? [`model = "${opts.model}"`] : []),
    ...(opts.reasoningEffort ? [`model_reasoning_effort = "${opts.reasoningEffort}"`] : []),
  ].join('\n')
  const block = `${top}

[model_providers.exe-llm]
name = "exe-llm"
base_url = "https://${gatewayHost}/v1"
requires_openai_auth = false
${opts.trustDir ? `\n[projects."${opts.trustDir}"]\ntrust_level = "trusted"\n` : ''}`
  writeFileSync(file, existing ? `${block}\n${existing}` : block)
}

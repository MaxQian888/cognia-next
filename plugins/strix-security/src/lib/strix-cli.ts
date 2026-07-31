// Build the strix invocation for a scan. Non-interactive mode (`-n`) disables
// the TUI and exits on completion (exit code 0 clean / 2 vulns / 1 error). The
// LLM model + key are passed via the environment (STRIX_LLM / LLM_API_KEY), not
// argv, so they never appear on the command line.

import type { ScanOptions } from "../types"
import { shellEscape } from "./shell-escape"

export function buildStrixCommand(opts: ScanOptions): string {
  return ["strix", "-n", "--target", shellEscape(opts.target)].join(" ")
}

/** Env overrides for a scan — only set what the user explicitly overrode. */
export function buildStrixEnv(opts: ScanOptions): Record<string, string> {
  const env: Record<string, string> = {}
  if (opts.model && opts.model.trim()) env.STRIX_LLM = opts.model.trim()
  if (opts.apiKey && opts.apiKey.trim()) env.LLM_API_KEY = opts.apiKey.trim()
  return env
}

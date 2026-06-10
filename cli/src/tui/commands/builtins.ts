/**
 * Pure presenters for the informational slash commands (`/tools`, `/cwd`,
 * `/about`). Kept out of the Ink component so the App router can produce notice
 * text deterministically and the logic is unit-tested without rendering.
 */
import type { BuiltinToolsConfig } from "@/lib/claude/types"

import type { ResolvedConfig } from "../../config/schema"

/** Human-readable label for each built-in tool category. */
const TOOL_LABELS: Record<string, string> = {
  coreFiles: "core file tools",
  coreFilesOnAnthropic: "core file tools on Anthropic",
  fileExtras: "file extras",
  git: "git",
  process: "process",
  environment: "environment",
  shellAdvanced: "advanced shell",
  terminalRepl: "terminal REPL",
  lsp: "LSP",
}

/**
 * Summarize which built-in tool categories are enabled. Returns a single line
 * suitable for a notice cell — "Enabled tools: …" or a hint when none are on.
 */
export function describeBuiltinTools(builtin: BuiltinToolsConfig): string {
  const enabled = Object.entries(builtin)
    .filter(([, on]) => on === true)
    .map(([key]) => TOOL_LABELS[key] ?? key)
  if (enabled.length === 0) return "No built-in tools are enabled."
  return `Enabled tools: ${enabled.join(", ")}`
}

/**
 * One-line summary of the active config for `/about`: provider, model, auth
 * mode, and permission mode.
 */
export function aboutLine(config: ResolvedConfig, version: string): string {
  const provider = config.provider
  const model = config.model ?? "default"
  const auth = authMode(config)
  return `cognia-agent v${version} · ${provider} · ${model} · ${auth} · ${config.permissionMode} mode`
}

/** Which credential the active provider will authenticate with. */
export function authMode(config: ResolvedConfig): string {
  return providerAuthMode(config, config.provider)
}

/** Which credential a specific provider id will authenticate with. */
export function providerAuthMode(config: ResolvedConfig, providerId: string): string {
  const p = config.providers[providerId]
  if (p?.authToken) return "subscription"
  if (p?.apiKey) return "api key"
  return "no credential"
}

import type { AgentTraceOtlpSettings } from "@/types/logging"

export type OtlpEgressMode = "host" | "collector" | "blocked"

export function resolveOtlpEgressPolicy(options: {
  isTauri: boolean
  preset: AgentTraceOtlpSettings["preset"]
}): OtlpEgressMode {
  if (options.preset === "off") return "blocked"
  if (options.isTauri) return "host"
  return options.preset === "grafana-cloud" ? "blocked" : "collector"
}

export function isCredentiallessOtlpEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint)
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    )
  } catch {
    return false
  }
}

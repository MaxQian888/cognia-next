import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginConversionReport } from "./ecosystem"

/** One list shared by the converter, CLI, inspection tool and target picker. */
export const PLUGIN_ECOSYSTEMS = [
  "cognia",
  "claude-code",
  "codex",
  "gemini-cli",
  "agent-plugins",
  "cursor",
  "copilot",
  "kimi",
  "devin",
  "opencode",
  "pi",
] as const
export type PluginDeliveryTarget = (typeof PLUGIN_ECOSYSTEMS)[number]
export type PluginDeliverySurface = "cli" | "desktop" | "cloud"

export interface PluginDeliveryAssessment {
  target: PluginDeliveryTarget
  surface: PluginDeliverySurface
  native: "ready" | "review-required" | "blocked"
  /** Static conversion never verifies an installed native host. */
  hostVerified: false
  capabilities?: Array<{
    capability: string
    status:
      "native" | "configuration-required" | "contextual" | "hosted" | "unsupported" | "unverified"
  }>
  hosted: {
    status: "requires-cognia" | "unavailable" | "unverified"
    capabilities: string[]
    /** These stay in Cognia; a tool bridge does not transplant them. */
    retained: string[]
  }
}

const HOSTED_TOOL_CAPABILITIES = new Set(["tools", "cli-tools"])
// Existing Cognia session adapters feed renderer-tool-host or the SDK tool
// bridge. This says where setup is possible, never that a lease is active.
const HOSTED_SESSION_TARGETS = new Set<PluginDeliveryTarget>([
  "claude-code",
  "codex",
  "gemini-cli",
  "devin",
  "opencode",
  "pi",
])

export function assessPluginDelivery({
  manifest,
  report,
  target,
  surface = "cli",
}: {
  manifest?: PluginManifest
  report: PluginConversionReport
  target: PluginDeliveryTarget
  surface?: PluginDeliverySurface
}): PluginDeliveryAssessment {
  const capabilities = [...new Set(manifest?.capabilities ?? [])]
  const hostedTools = capabilities.filter((capability) => HOSTED_TOOL_CAPABILITIES.has(capability))
  const hostedStatus =
    target === "cognia" || hostedTools.length === 0
      ? "unavailable"
      : surface === "cloud" || !HOSTED_SESSION_TARGETS.has(target)
        ? "unverified"
        : "requires-cognia"
  const aliases: Record<string, string> = {
    agents: "subagent",
    hooks: "command-hooks",
    commandHooks: "command-hooks",
    mcpServers: "mcp-server-preset",
    mcp: "mcp-server-preset",
  }
  const canonicalCapability = (value: string) =>
    value.startsWith("skill-") ? "skills" : (aliases[value] ?? value)
  const listed = [
    ...new Set([
      ...capabilities,
      ...[...report.converted, ...report.warnings, ...report.blocking].map((issue) =>
        canonicalCapability(issue.capability)
      ),
    ]),
  ]
  const details: NonNullable<PluginDeliveryAssessment["capabilities"]> = listed.map(
    (capability) => {
      const blocked = report.blocking.some(
        (issue) => canonicalCapability(issue.capability) === capability
      )
      const warning = report.warnings.some(
        (issue) => canonicalCapability(issue.capability) === capability
      )
      const converted = report.converted.some(
        (issue) => canonicalCapability(issue.capability) === capability
      )
      const status = blocked
        ? hostedStatus === "requires-cognia" && HOSTED_TOOL_CAPABILITIES.has(capability)
          ? "hosted"
          : "unsupported"
        : capability === "mcp-server-preset" &&
            manifest?.mcpServerPresets?.some((preset) => preset.fields?.length)
          ? "configuration-required"
          : warning
            ? report.fidelity === "contextual"
              ? "contextual"
              : "unverified"
            : report.blocking.length && !converted
              ? "unverified"
              : "native"
      return { capability, status }
    }
  )
  return {
    target,
    surface,
    native: report.blocking.length
      ? "blocked"
      : report.warnings.length || report.fidelity === "contextual"
        ? "review-required"
        : "ready",
    hostVerified: false,
    capabilities: details,
    hosted: {
      status: hostedStatus,
      capabilities: hostedTools,
      retained: capabilities.filter((capability) => !HOSTED_TOOL_CAPABILITIES.has(capability)),
    },
  }
}

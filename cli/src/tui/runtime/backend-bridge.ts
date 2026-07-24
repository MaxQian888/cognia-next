/**
 * What Cognia can actually hand an external agent.
 *
 * The external session used to forward almost nothing — `mcpServers` was a
 * hardcoded empty array, and the thinking level and skills stopped at the CLI
 * boundary — while the UI kept offering all three as if they worked. This module
 * is the honest half of that: it computes exactly what the active protocol can
 * carry, so the capability gate can advertise a feature only where something is
 * genuinely forwarded.
 *
 * Two seams exist, and they are NOT interchangeable:
 *   - `context.custom.mcpServers` → `session/new` (ACP and Codex both accept it),
 *     resolved per turn, so a `/mcp` toggle can take effect on the next message.
 *   - `codexOptions` on the AGENT config → Codex app-server metadata, which is
 *     the only channel reasoning effort and extra skill roots have. It is read
 *     when the agent is registered, so those are connect-time facts.
 *
 * Pure: every filesystem read is injected.
 */
import type { McpServer } from "@cognia/agent-config-types"
import type { AcpMcpServerConfig, CodexAgentOptions } from "@/types/agent/external-agent"
import { mcpServerToAcpConfig } from "@/lib/ai/agent/external/resolve-acp-mcp-servers"

import type { ResolvedConfig, ThinkingLevel } from "../../config/schema"
import { usesCodexOptions } from "./backend-capabilities"

/**
 * Project the CLI's resolved MCP servers into the ACP session shape.
 *
 * Reuses the desktop projection (`mcpServerToAcpConfig`) rather than a second
 * mapping, and drops anything malformed the same way — a stdio server with no
 * command, or an in-process transport an external process cannot dial. ACP keys
 * servers by name, so a duplicate name keeps the first.
 */
export function toAcpMcpServers(servers: McpServer[]): AcpMcpServerConfig[] {
  const out: AcpMcpServerConfig[] = []
  const seen = new Set<string>()
  for (const server of servers) {
    // `/mcp disable` is represented on the resolved row. Never forward a
    // disabled server (or its env/header credentials) across the external
    // agent boundary merely because its underlying config is still present.
    if (!server.enabled) continue
    if (seen.has(server.name)) continue
    const acp = mcpServerToAcpConfig(server)
    if (!acp) continue
    out.push(acp)
    seen.add(server.name)
  }
  return out
}

/**
 * Map a CLI thinking level onto a Codex reasoning effort.
 *
 * `off` means "leave the model at its own default", which is expressed by
 * forwarding nothing rather than by inventing a level. `ultracode` is a Cognia
 * composite tier whose extra half (in-tree plugin tools) has no external
 * equivalent; only its effort survives, which is why the capability gate
 * describes this as partial rather than as parity.
 */
export function toCodexReasoningEffort(level: ThinkingLevel | undefined): string | undefined {
  if (!level || level === "off") return undefined
  return level === "ultracode" ? "xhigh" : level
}

/**
 * The directories Codex should scan for `SKILL.md`, beyond its own defaults.
 *
 * This is Codex's native skill discovery, not a prompt injection: the agent
 * loads the skills itself, so they behave the way its own skills do. ACP has no
 * counterpart, which is why skills stay gated off there instead of being faked
 * by pasting bodies into the system prompt.
 */
export function toCodexSkillRoots(config: ResolvedConfig): string[] {
  if (config.externalSkills === false) return []
  const roots = config.skillDirs ?? []
  return [...new Set(roots.filter((root) => root.trim().length > 0))]
}

/** Build the `codexOptions` an agent config should carry, or undefined when the
 * preset does not read that channel and nothing would be forwarded. */
export function buildCodexOptions(
  config: ResolvedConfig,
  presetId: string | undefined
): CodexAgentOptions | undefined {
  if (!usesCodexOptions(presetId)) return undefined
  const effort = toCodexReasoningEffort(config.thinkingLevel)
  const skillRoots = toCodexSkillRoots(config)
  if (!effort && skillRoots.length === 0) return undefined
  return {
    ...(effort ? { defaultReasoningEffort: effort } : {}),
    ...(skillRoots.length > 0 ? { extraSkillRoots: skillRoots } : {}),
  }
}

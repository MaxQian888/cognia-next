/**
 * Whether the runtime a builder conversation runs on can call Cognia's
 * built-in tools (ADR-0220). The built-in lane always can. An external agent
 * can when its protocol carries MCP natively or through an equivalent bridge
 * (the renderer tool host); one that declares no MCP surface can still talk,
 * but cannot fill the draft, and the builder says so up front.
 */

import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { buildDeclaredCapabilityProfile } from "@/lib/ai/agent/external/capability/capability-profile"

export type RuntimeToolSupport = "supported" | "unsupported" | "unknown"

export function runtimeToolSupport(
  ref: AgentRuntimeRef,
  protocolOf: (ref: Exclude<AgentRuntimeRef, { kind: "builtin" }>) => string | undefined
): RuntimeToolSupport {
  if (ref.kind === "builtin") return "supported"
  const protocol = protocolOf(ref)
  if (!protocol) return "unknown"
  const level = buildDeclaredCapabilityProfile({ protocol }).effective.mcp.level
  return level === "native" || level === "equivalent" ? "supported" : "unsupported"
}

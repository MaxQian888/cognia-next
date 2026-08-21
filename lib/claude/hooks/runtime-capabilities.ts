import type { HookEvent, HookHandlerType } from "@/lib/claude/hooks"
import { HOOK_EVENTS } from "./event-catalog"

export const HOOK_CAPABILITY_CONTRACT_VERSION = 1 as const

export type HookProvider = "claude" | "codex" | "opencode" | "unknown"
export type HookExecutionOwner = "sdk" | "provider" | "host" | "none"

export interface HookRuntimeProbe {
  runtimeVersion?: string
  events?: readonly string[]
  handlerTypes?: readonly string[]
}

export interface HookRuntimeCapabilities {
  contractVersion: typeof HOOK_CAPABILITY_CONTRACT_VERSION
  provider: HookProvider
  runtimeVersion?: string
  events: readonly HookEvent[]
  handlerTypes: readonly HookHandlerType[]
  executionOwner: HookExecutionOwner
  probed: boolean
  degraded: boolean
  degradedReason?: "not-probed" | "unknown-runtime" | "probe-intersection"
}

export const CODEX_HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
]

const CLAUDE_HANDLER_TYPES: readonly HookHandlerType[] = [
  "command",
  "http",
  "mcp_tool",
  "prompt",
  "agent",
  // Runs an installed plugin's in-process hook handler. Sidecar-only: it needs
  // the renderer round-trip (`sidecar/dispatch/plugin-hook-exec.mjs`), which is
  // why the codex/opencode manifests below do not list it.
  "plugin",
]

const MANIFESTS: Record<HookProvider, Omit<HookRuntimeCapabilities, "runtimeVersion">> = {
  claude: {
    contractVersion: HOOK_CAPABILITY_CONTRACT_VERSION,
    provider: "claude",
    events: HOOK_EVENTS,
    handlerTypes: CLAUDE_HANDLER_TYPES,
    executionOwner: "sdk",
    probed: false,
    degraded: false,
    degradedReason: "not-probed",
  },
  codex: {
    contractVersion: HOOK_CAPABILITY_CONTRACT_VERSION,
    provider: "codex",
    events: CODEX_HOOK_EVENTS,
    handlerTypes: ["command"],
    executionOwner: "provider",
    probed: false,
    degraded: false,
    degradedReason: "not-probed",
  },
  opencode: {
    contractVersion: HOOK_CAPABILITY_CONTRACT_VERSION,
    provider: "opencode",
    events: [],
    handlerTypes: [],
    executionOwner: "host",
    probed: false,
    degraded: true,
    degradedReason: "not-probed",
  },
  unknown: {
    contractVersion: HOOK_CAPABILITY_CONTRACT_VERSION,
    provider: "unknown",
    events: [],
    handlerTypes: [],
    executionOwner: "none",
    probed: false,
    degraded: true,
    degradedReason: "unknown-runtime",
  },
}

export function knownHookRuntimeCapabilities(provider: HookProvider): HookRuntimeCapabilities {
  const manifest = MANIFESTS[provider]
  return {
    ...manifest,
    events: [...manifest.events],
    handlerTypes: [...manifest.handlerTypes],
  }
}

/**
 * A probe may only remove capabilities from the audited manifest. It can never
 * promote an unknown event or handler based on an untrusted runtime response.
 */
export function resolveHookRuntimeCapabilities(
  provider: HookProvider,
  probe?: HookRuntimeProbe | null
): HookRuntimeCapabilities {
  const baseline = knownHookRuntimeCapabilities(provider)
  if (!probe) return baseline

  const reportedEvents = new Set(probe.events ?? [])
  const reportedHandlers = new Set(probe.handlerTypes ?? [])
  const events = baseline.events.filter((event) => reportedEvents.has(event))
  const handlerTypes = baseline.handlerTypes.filter((type) => reportedHandlers.has(type))
  const degraded =
    events.length !== baseline.events.length || handlerTypes.length !== baseline.handlerTypes.length

  return {
    ...baseline,
    runtimeVersion: probe.runtimeVersion,
    events,
    handlerTypes,
    probed: true,
    degraded,
    degradedReason: degraded ? "probe-intersection" : undefined,
  }
}

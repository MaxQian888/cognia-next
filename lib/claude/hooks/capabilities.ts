import type { HookEvent, HookHandler } from "@/lib/claude/hooks"
import { HOOK_EVENTS } from "./event-catalog"

export type HookRuntimeId = "claude-agent-sdk" | "rust-host" | "cli"
export type HookHandlerType = HookHandler["type"] | "prompt" | "agent" | "mcp_tool"

export interface HookRuntimeDescriptor {
  id: HookRuntimeId
  version: string
  events: readonly HookEvent[]
  handlers: Readonly<Record<HookHandlerType, "supported" | "unsupported">>
  ownership: "sdk-native" | "host-native"
  timeoutSeconds: { default: number; maximum: number }
  piiGate: "required" | "not-applicable"
}

const baseHandlers: Record<HookHandlerType, "supported" | "unsupported"> = {
  command: "supported",
  http: "supported",
  webhook: "supported",
  prompt: "unsupported",
  agent: "unsupported",
  mcp_tool: "unsupported",
}

export const HOOK_RUNTIME_CAPABILITIES: Readonly<Record<HookRuntimeId, HookRuntimeDescriptor>> = {
  "claude-agent-sdk": {
    id: "claude-agent-sdk",
    version: "0.3.220",
    events: HOOK_EVENTS,
    handlers: baseHandlers,
    ownership: "sdk-native",
    timeoutSeconds: { default: 5, maximum: 30 },
    piiGate: "required",
  },
  "rust-host": {
    id: "rust-host",
    version: "1",
    events: HOOK_EVENTS,
    handlers: baseHandlers,
    ownership: "host-native",
    timeoutSeconds: { default: 5, maximum: 30 },
    piiGate: "required",
  },
  cli: {
    id: "cli",
    version: "1",
    events: HOOK_EVENTS,
    handlers: { ...baseHandlers, http: "unsupported", webhook: "unsupported" },
    ownership: "host-native",
    timeoutSeconds: { default: 60, maximum: 60 },
    piiGate: "not-applicable",
  },
}

export function hookRuntimeCapability(id: HookRuntimeId): HookRuntimeDescriptor {
  return HOOK_RUNTIME_CAPABILITIES[id]
}

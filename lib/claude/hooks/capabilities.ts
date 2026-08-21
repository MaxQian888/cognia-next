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

/**
 * Handlers every rail can spawn or POST itself. The model-backed three
 * (`prompt` / `agent` / `mcp_tool`) are NOT here — they need a nested `query()`,
 * which only the sidecar can run.
 */
const commandAndHttpHandlers: Record<HookHandlerType, "supported" | "unsupported"> = {
  command: "supported",
  http: "supported",
  webhook: "supported",
  prompt: "unsupported",
  agent: "unsupported",
  mcp_tool: "unsupported",
  // Needs the renderer round-trip only the sidecar can perform.
  plugin: "unsupported",
}

export const HOOK_RUNTIME_CAPABILITIES: Readonly<Record<HookRuntimeId, HookRuntimeDescriptor>> = {
  "claude-agent-sdk": {
    id: "claude-agent-sdk",
    version: "0.3.220",
    events: HOOK_EVENTS,
    // The model-backed handlers ARE implemented on this rail:
    // `sidecar/dispatch/hook-native-executor.mjs` runs them as nested `query()`
    // calls behind a cost governor and a depth-1 recursion cap. This table
    // claimed otherwise long after that shipped, and it is the ONLY thing the
    // settings panel reads to decide which handler types a user may pick — so
    // the panel was hiding working functionality.
    handlers: {
      command: "supported",
      http: "supported",
      webhook: "supported",
      prompt: "supported",
      agent: "supported",
      mcp_tool: "supported",
      // Runs an installed plugin's own hook handler via `plugin_hook_exec`.
      plugin: "supported",
    },
    ownership: "sdk-native",
    timeoutSeconds: { default: 5, maximum: 30 },
    piiGate: "required",
  },
  "rust-host": {
    id: "rust-host",
    version: "1",
    events: HOOK_EVENTS,
    // Genuinely command/HTTP only: `HookHandler` in `src-tauri/src/hooks/
    // types.rs` deserializes the model-backed three to `Unsupported`, which
    // soft-allows with a warning.
    handlers: commandAndHttpHandlers,
    ownership: "host-native",
    timeoutSeconds: { default: 5, maximum: 30 },
    piiGate: "required",
  },
  cli: {
    id: "cli",
    version: "1",
    events: HOOK_EVENTS,
    // This describes the CLI's OWN fallback runner (`cli/src/hooks/run-hooks.ts`),
    // which spawns commands and nothing else — `webhook`/`http` and every
    // unknown handler type are explicitly inert there. It is no longer the
    // CLI's primary path: the CLI now injects its merged config into
    // `sendOptions.hooks` (`cli/src/hooks/resolve-hooks-config.ts`) so a CLI
    // turn actually executes on the `claude-agent-sdk` rail above, with that
    // rail's full capabilities. The fallback still serves the case where
    // nothing is configured to inject.
    handlers: { ...commandAndHttpHandlers, http: "unsupported", webhook: "unsupported" },
    ownership: "host-native",
    timeoutSeconds: { default: 60, maximum: 60 },
    piiGate: "not-applicable",
  },
}

export function hookRuntimeCapability(id: HookRuntimeId): HookRuntimeDescriptor {
  return HOOK_RUNTIME_CAPABILITIES[id]
}

/**
 * Agent surfaces that lifecycle hooks deliberately do NOT cover.
 *
 * Every other agent path bottoms out at `runAndCaptureAssistantReply` →
 * `claude_send`, where the host injects the hook config, so it is covered for
 * free. These three do not: they build a renderer-side `LlmClient` and call the
 * provider directly, bypassing the sidecar where SDK-native hooks live.
 * Covering them would mean a fourth hook rail, not a fire site.
 *
 * Surfaced (not hidden) so the settings panel can say so — a hook author who
 * expects `PreToolUse` to gate the desktop pet deserves to find out here rather
 * than by watching it not happen. i18n labels are looked up by convention under
 * `settings.hooks.coverage.<id>`.
 */
export interface HookUncoveredSurface {
  id: string
  /** Where the uncovered call lives, for the code comment to point back at. */
  source: string
}

export const HOOK_UNCOVERED_SURFACES: readonly HookUncoveredSurface[] = [
  { id: "petProactive", source: "hooks/pet/use-pet-proactive.ts" },
  { id: "radar", source: "lib/radar/generate.ts" },
  { id: "completionRail", source: "lib/ai/agent/agent-executor.ts" },
]

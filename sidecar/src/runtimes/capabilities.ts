/**
 * Capability tables mirror `RUNTIME_CAPABILITIES` in
 * `lib/ai/agent/execution/resolve-agent-execution-spec.ts` for the host-level
 * command surface. Only command-relevant capabilities appear here — the ones
 * `COMMAND_CAPABILITIES` below can gate on. A capability listed there but
 * missing here rejects a command the runtime can in fact serve, so the two must
 * be read together; `check-adapter-capability-parity.mjs` enforces that.
 */
export const ADAPTER_CAPABILITIES = {
  "claude-agent-sdk": new Set([
    "session.multi-turn",
    "session.resume",
    "permissions.interrupt-resume",
    "permissions.set-mode",
    "subagents.native",
    // Steering is implemented for this rail and this rail only — `routeSteer()`
    // in agent-host.mjs rejects every non-anthropic provider.
    "steer",
    "set-model",
    "compaction",
    // Capabilities the CONTROL surface gates on (see
    // `CONTROL_METHOD_CAPABILITIES` in control.mjs). They earn their place
    // here because `handleControl` now rejects an ungated control with a typed
    // `capability_error` instead of letting it fail as `unsupported_provider`.
    "context-management",
    "mcp",
    "thinking",
    "commands.dynamic",
    "session.manage",
    "plugins.native",
    "skills.native",
    "checkpoint",
    "mcp.dynamic",
    "subagents.manage",
    "tasks.background",
  ]),
  "ai-sdk": new Set([
    "session.multi-turn",
    "permissions.interrupt-resume",
    "permissions.set-mode",
    "set-model",
    "compaction",
  ]),
}

/** Host-command → capability requirement (commands absent here are universal). */
export const COMMAND_CAPABILITIES = {
  compact: "compaction",
  restore: "compaction",
  set_mode: "permissions.set-mode",
  steer: "steer",
}

/**
 * Typed capability error payload (ADR-0090 §3.5 `capability-error`). Emitted
 * by the host when a session's adapter cannot serve a command.
 */
export function capabilityError(
  sessionId: string | undefined,
  capability: string | undefined,
  command: string | undefined
) {
  return {
    type: "capability_error",
    sessionId,
    capability,
    command,
  }
}

/**
 * Whether `command` is servable by the adapter that runs `session`. Sessions
 * without a frozen adapter id (legacy) are never blocked here — their
 * dispatchers keep today's behavior.
 */
export function commandSupported(adapterId: string | undefined, command: string) {
  const required = COMMAND_CAPABILITIES[command as keyof typeof COMMAND_CAPABILITIES]
  if (!required) return true
  return capabilitySupported(adapterId, required)
}

/**
 * Whether the adapter behind a session declares `capability`.
 *
 * Split out of {@link commandSupported} for the control surface, which is
 * keyed by SDK method name rather than by host command and so cannot go
 * through `COMMAND_CAPABILITIES`. Same two escapes: a session with no frozen
 * adapter id (legacy) and an adapter this build does not know are both
 * permissive, because blocking there would reject a session whose capabilities
 * we simply cannot read.
 */
export function capabilitySupported(adapterId: string | undefined, capability: string | undefined) {
  if (!adapterId || !capability) return true
  const table = ADAPTER_CAPABILITIES[adapterId as keyof typeof ADAPTER_CAPABILITIES]
  if (!table) return true
  return table.has(capability)
}

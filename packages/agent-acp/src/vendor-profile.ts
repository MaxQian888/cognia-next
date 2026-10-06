/**
 * ACP vendor profiles (ADR-0217).
 *
 * Every ACP agent speaks the same protocol, but several deviate from it in
 * ways the client has to know about: a different permission-mode vocabulary,
 * a tool identity carried in vendor metadata, a fork that cannot rebind MCP
 * servers, a capability that is advertised but not honoured. A profile states
 * those deviations as data and small pure functions; the client applies them
 * at fixed points and has no vendor names of its own.
 *
 * A configuration without a matching profile is a plain ACP agent. Profiles
 * describe protocol behaviour only: they grant nothing, and the host's
 * approval policy and permission broker still decide every tool call.
 */

import type { AcpPermissionMode, ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"

/** How a vendor names permission modes on the wire. */
export interface AcpVendorPermissionModes {
  /** The wire mode for a canonical mode. */
  toNative(mode: AcpPermissionMode): string
  /**
   * The canonical mode for a wire mode the agent reported. `current` is the
   * session's canonical mode, so a wire value several canonical modes share
   * keeps the one the user chose.
   */
  toCanonical(nativeMode: string, current: AcpPermissionMode | undefined): AcpPermissionMode
  /**
   * Refuse a mode the session does not advertise instead of sending it.
   * `fallback` is the wire set assumed when the agent advertised none.
   */
  requireAdvertised?: { fallback: readonly string[] }
}

/** The tool identity a vendor carries in its tool-call metadata. */
export interface AcpVendorToolIdentity {
  name?: string
  /** Permission category (`read`, `edit`, …) when the agent's own kind is unusable. */
  kind?: string
}

export interface AcpVendorProfile {
  /** Stable id; also the preset id that selects the profile. */
  id: string
  /** Name used in error messages. */
  label: string
  /** Executable basenames (without `.exe`) that select the profile for hand-made configs. */
  commandNames: readonly string[]
  permissionModes?: AcpVendorPermissionModes
  /** Environment forced at launch, over the configuration's own values. */
  launchEnv?: Readonly<Record<string, string>>
  /** Set when the agent ignores session MCP servers; creating a session with any is refused. */
  sessionMcpServersUnsupported?: string
  /** Prompt capabilities the agent advertises but does not honour. */
  promptCapabilityOverrides?: Readonly<{ image?: boolean }>
  /** The agent's compaction command starts background work it never reports finishing. */
  compactionCompletionUnavailable?: Readonly<{ reason: string; message: string }>
  fork?: Readonly<{
    /** A fork always runs in the source session's workspace; asking for another is refused. */
    inheritsSourceWorkspace: boolean
    /** The fork must come back with a new session id. */
    requiresDistinctSessionId: boolean
    /**
     * The agent ignores MCP servers on `session/fork` and on live restore, so
     * the client binds them by closing and re-loading the fork. A fork made
     * without servers (from the UI) is bound when it first executes.
     */
    rebindsMcpByReload: boolean
  }>
  /** Tool identity recovered from vendor metadata, for the host's permission callback. */
  toolIdentity?(meta: Record<string, unknown> | undefined): AcpVendorToolIdentity | undefined
  /** Match `dontAsk` allow-lists against the tool name instead of the generated title. */
  preApprovalMatchesToolName?: boolean
}

function commandBasenameMatches(command: string | undefined, names: readonly string[]): boolean {
  if (!command) return false
  return names.some((name) =>
    new RegExp(`(?:^|[\\\\/])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.exe)?$`, "i").test(
      command
    )
  )
}

/**
 * The profile a configuration runs with: the one whose id is the
 * configuration's preset, else the first whose executable it launches, else
 * none (a plain ACP agent).
 */
export function resolveAcpVendorProfile(
  config: Pick<ExternalAgentConfig, "metadata" | "process"> | null | undefined,
  profiles: readonly AcpVendorProfile[]
): AcpVendorProfile | undefined {
  const preset = config?.metadata?.preset
  if (typeof preset === "string") {
    const byPreset = profiles.find((profile) => profile.id === preset)
    if (byPreset) return byPreset
  }
  const command = config?.process?.command
  return profiles.find((profile) => commandBasenameMatches(command, profile.commandNames))
}

/**
 * The send-option half of an unattended run's permission profile (ADR-0224 A7).
 *
 * A Bot or scheduled-task turn carries a `permissionProfile` on its capability
 * grant. `resolveSendOptions` hands this module the folded grant once the tool
 * surface is final, and it stamps what the sidecar needs to enforce it:
 *
 *   - the resolved profile (every class decided, never above the ceiling);
 *   - the classes of each plugin tool, derived from the declaring plugin's
 *     manifest permissions, so the sidecar can tell an outbound send from a
 *     note search without trusting the model or the tool's own description;
 *   - an attestation when the turn's sandbox placement is isolated, which is
 *     what lets the sidecar allow the sandboxed tools without asking;
 *   - a TTL on every permission request, a backstop behind the host's park.
 *
 * An interactive turn has no profile on its grant and passes through
 * untouched: none of these fields appear on its send options.
 */

import type { PermissionClass, SandboxAttestationV1, SendOptions } from "@cognia/agent-config-types"
import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import { resolvePermissionProfile } from "@cognia/agent-config-types"

import { UNATTENDED_SIDECAR_APPROVAL_TTL_MS } from "./unattended-park"

/** Plugin permissions whose holder can reach people or services outside the host. */
export const OUTBOUND_PLUGIN_PERMISSIONS: ReadonlySet<string> = new Set([
  "connectors:send",
  "share:create",
  "network:upload",
])

/** Plugin permissions that read or write stored credentials. */
export const SECRET_PLUGIN_PERMISSIONS: ReadonlySet<string> = new Set([
  "secrets:read",
  "secrets:write",
])

/** Plugin permissions that change how the host itself is configured. */
export const HOST_CONFIG_PLUGIN_PERMISSIONS: ReadonlySet<string> = new Set([
  "connectors:manage",
  "agent:external:manage",
  "backup:write",
  "companion:control",
  "commands:write",
])

/** Plugin permissions that write the workspace or run processes in it. */
export const WORKSPACE_PLUGIN_PERMISSIONS: ReadonlySet<string> = new Set([
  "filesystem:write",
  "shell:execute",
  "process:spawn",
  "terminal:spawn",
  "terminal:write",
  "git:write",
  "python:execute",
  "notebook:execute",
  "cli:execute",
  "tests:run",
  "native:filesystem",
  "native:process",
])

/**
 * First-party tools the host synthesizes outside any plugin manifest, with the
 * classes their effect puts them in. Every other host-synthesized tool reads,
 * renders or edits this app's own records and is in no class.
 */
export const HOST_TOOL_CLASSES: Readonly<Record<string, readonly PermissionClass[]>> =
  Object.freeze({
    // Publishes a site to an external host.
    deploy_site: ["outbound"],
    // Give someone outside the conversation access to its files (ADR-0222 §9).
    filespace_share: ["outbound"],
    filespace_enable_webdav: ["outbound"],
    // Puts a stored password into a web page (ADR-0201).
    browser_fill_credential: ["secrets"],
  })

type PluginTool = NonNullable<SendOptions["pluginTools"]>[number]

/**
 * The classes one plugin tool belongs to. `declaredPermissions` is the
 * declaring plugin's manifest list (empty for host-synthesized tools). A tool
 * that declared read-only filesystem access is not an outbound, host
 * configuration or workspace tool, whatever else its plugin may do; it can
 * still be secret use.
 */
export function classesForPluginTool(
  tool: Pick<PluginTool, "name" | "access">,
  declaredPermissions: readonly string[]
): PermissionClass[] {
  const classes = new Set<PermissionClass>(HOST_TOOL_CLASSES[tool.name] ?? [])
  const has = (set: ReadonlySet<string>) => declaredPermissions.some((p) => set.has(p))
  if (has(SECRET_PLUGIN_PERMISSIONS)) classes.add("secrets")
  if (tool.access !== "read") {
    if (has(OUTBOUND_PLUGIN_PERMISSIONS)) classes.add("outbound")
    if (has(HOST_CONFIG_PLUGIN_PERMISSIONS)) classes.add("hostConfig")
    if (has(WORKSPACE_PLUGIN_PERMISSIONS)) classes.add("workspace")
  }
  return [...classes]
}

export interface UnattendedPermissionDeps {
  /** The declaring plugin's manifest permissions, or empty when it has none. */
  pluginPermissions: (pluginId: string) => readonly string[]
  /** An attestation for the turn's sandbox placement, when it is isolated. */
  attestSandbox: (ref: string | undefined) => SandboxAttestationV1 | null
}

/** Stamp the profile fields onto a resolved send. A no-op without a profile. */
export function applyUnattendedPermissionProfile(
  opts: SendOptions,
  grant: Pick<AgentCapabilityGrantV1, "permissionProfile"> | undefined,
  deps: UnattendedPermissionDeps
): SendOptions {
  if (!grant?.permissionProfile) return opts
  opts.permissionProfile = resolvePermissionProfile(grant.permissionProfile)
  opts.approvalTtlMs = UNATTENDED_SIDECAR_APPROVAL_TTL_MS
  if (opts.pluginTools) {
    opts.pluginTools = opts.pluginTools.map((tool) => {
      const classes = classesForPluginTool(tool, deps.pluginPermissions(tool.pluginId))
      return classes.length > 0 ? { ...tool, permissionClasses: classes } : tool
    })
  }
  const attestation = deps.attestSandbox(opts.sandboxRuntimeRef)
  if (attestation) opts.sandboxAttestation = attestation
  else delete opts.sandboxAttestation
  return opts
}

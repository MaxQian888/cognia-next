/**
 * Client for an isolated configuration's private state root (ADR-0216).
 *
 * An `isolated` external-agent configuration keeps its logins, sessions and
 * settings under `<data_dir>/cognia/external-agents/<configId>` on the machine
 * that runs it. The spawn backends create that root; these two calls let the
 * lifecycle report its size and delete it with the configuration.
 *
 * Both commands are local-only (`external_agent_state_root_info` /
 * `external_agent_state_root_remove`, target `client` in
 * `protocol/companion-commands.json`): they are answered by the desktop's Tauri
 * commands or, in the CLI and the headless brain, by the Node backend. They
 * are only meaningful where THIS shell owns the process table — a browser or
 * phone has no root of its own, and with a remote Host selected the configs
 * shown are the Host's, whose roots the Host deletes when it deletes the
 * configuration. In both cases info is `null` and remove is a no-op.
 */
import { agentInvoke } from "../agent-transport"
import { externalAgentProcessPlane } from "../capability/process-plane"
import { AGENT_STATE_KEY_PATTERN } from "../policy/security-policy"

/** Disk facts about one configuration's private state root. */
export interface ExternalAgentStateRootInfo {
  /** Absolute path on the machine that owns the root. */
  path: string
  exists: boolean
  /** Total size of the regular files under the root. */
  bytes: number
}

export const STATE_ROOT_INFO_COMMAND = "external_agent_state_root_info" as const
export const STATE_ROOT_REMOVE_COMMAND = "external_agent_state_root_remove" as const

/** Does this shell run external agents in its own process table right now? */
function ownsLocalStateRoots(): boolean {
  const plane = externalAgentProcessPlane()
  return plane.ok && plane.via === "local"
}

function parseInfo(value: unknown): ExternalAgentStateRootInfo {
  const record = value as Partial<ExternalAgentStateRootInfo> | null
  if (
    !record ||
    typeof record.path !== "string" ||
    typeof record.exists !== "boolean" ||
    typeof record.bytes !== "number" ||
    !Number.isFinite(record.bytes) ||
    record.bytes < 0
  ) {
    throw new Error(`${STATE_ROOT_INFO_COMMAND} returned a malformed answer`)
  }
  return { path: record.path, exists: record.exists, bytes: record.bytes }
}

/**
 * Where a configuration's private state root lives and how much it holds, or
 * `null` when this shell owns no state roots (browser, phone, remote Host
 * selected) or the id could never have named one (every spawn backend refuses
 * a key outside `AGENT_STATE_KEY_PATTERN`).
 */
export async function getExternalAgentStateRootInfo(
  configId: string
): Promise<ExternalAgentStateRootInfo | null> {
  if (!AGENT_STATE_KEY_PATTERN.test(configId) || !ownsLocalStateRoots()) return null
  return parseInfo(await agentInvoke<unknown>(STATE_ROOT_INFO_COMMAND, { key: configId }))
}

/**
 * Delete a configuration's private state root. Removing a root that does not
 * exist succeeds. Returns whether the delete was sent to a host that owns
 * roots; `false` means there was nothing here to delete (see
 * {@link getExternalAgentStateRootInfo} for when). A host failure rejects.
 */
export async function removeExternalAgentStateRoot(configId: string): Promise<boolean> {
  if (!AGENT_STATE_KEY_PATTERN.test(configId) || !ownsLocalStateRoots()) return false
  await agentInvoke<void>(STATE_ROOT_REMOVE_COMMAND, { key: configId })
  return true
}

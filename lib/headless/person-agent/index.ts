/**
 * Wiring for a member partition's sandboxed agents (P6e).
 *
 * The person brain installs this once at boot when the Host advertised
 * `COGNIA_PERSON_EXECUTION=sandboxed` (`lib/headless/runtimes/person-agent.ts`).
 * It owns the brain's single external-agent host: nothing else in a person
 * brain spawns agent processes, and the operator brain never installs it.
 */

import { renderTranscript } from "@/lib/chat/branch-session"
import { installExternalAgentHost } from "@/lib/ai/agent/external/host/installed-host"
import { findRuntimeById } from "@/lib/ai/agent/external/config/install-catalog"
import { cogniaGatewayRuntime } from "@/lib/ai/agent/external/config/gateway-task"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"
import { applyExternalAgentEventToParts } from "@/lib/ai/agent/external/session/event-to-parts"
import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import { TRANSCRIPT_LIVE_TOPIC } from "@/lib/chat/transcript/live-frames"
import { pickPermissionOptionId } from "@/lib/ai/agent/external/session/chat-decision-bridge"
import type { AcpPermissionOption } from "@/types/agent/external-agent"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { createPersonProcessPlane, type PersonPlaneTransport } from "./process-plane"
import {
  createPersonAgentRunner,
  type PersonAgentLease,
  type PersonAgentManager,
  type PersonAgentRunner,
} from "./runner"

export { fetchPersonAgentPolicy, resolvePersonAgent } from "./policy"
export type { PersonAgentPolicy, PersonAgentResolution } from "./policy"
export { PersonAgentTurnError } from "./runner"

let runner: PersonAgentRunner | null = null

/** The installed runner, or `null` when this brain runs no member agents. */
export function getPersonAgentRunner(): PersonAgentRunner | null {
  return runner
}

/** The catalog launch for a bundled runtime: its preset, command and gateway family. */
export function personAgentLaunch(
  runtimeId: string
): { config: ExternalAgentConfig; family: string } | undefined {
  const entry = findRuntimeById(runtimeId)
  const presetId = entry?.presetIds[0]
  if (!entry?.systemCommand || !presetId) return undefined
  const config = createAgentFromPreset(presetId, {
    process: { command: entry.systemCommand, args: [...(entry.launchArgs ?? [])] },
  })
  if (!config?.process || config.transport !== "stdio") return undefined
  const family = cogniaGatewayRuntime(config)
  return family ? { config, family } : undefined
}

export interface PersonAgentInstallDeps {
  transport: PersonPlaneTransport
  manager: PersonAgentManager
  log(level: "info" | "warn" | "error", message: string): void
}

/** Install the host and runner; resolves once the Host's stop channels are live. */
export async function installPersonAgents(
  deps: PersonAgentInstallDeps
): Promise<() => Promise<void>> {
  const plane = createPersonProcessPlane(deps.transport)
  const uninstallHost = installExternalAgentHost(plane.host)
  let stopWatching: () => void = () => {}
  try {
    stopWatching = await plane.watchStops()
  } catch (error) {
    uninstallHost()
    throw error
  }
  const [
    { listMessages, commitMessageDelta },
    { getSession },
    { settleChatTurn },
    { hostStateRunId },
    writeSource,
  ] = await Promise.all([
    import("@/lib/db/messages"),
    import("@/lib/db/sessions"),
    import("@/lib/work-submission/chat-adapter"),
    import("@/lib/work-submission/host-adapter"),
    import("@/lib/companion/desktop-write-source"),
  ])
  const installed = createPersonAgentRunner({
    plane,
    manager: deps.manager,
    prepareLease: (input) =>
      deps.transport.call<PersonAgentLease>("person_agent_lease_prepare", { ...input }),
    launchFor: personAgentLaunch,
    history: async (sessionId, excluded) =>
      renderTranscript(
        (await listMessages(sessionId)).filter((message) => !excluded.includes(message.id))
      ),
    writeMessage: (sessionId, message) => commitMessageDelta(sessionId, { upserts: [message] }),
    // By the turn's own run id: a message queued behind it is a newer open
    // submission of the same conversation.
    settle: async (actionId, input) => {
      await settleChatTurn({ runId: hostStateRunId(actionId), ...input })
    },
    project: (envelope) => writeSource.projectBrainRuntimeEnvelope(envelope),
    // The brain's registered publisher pipes it over the bridge; the Host
    // delivers it only to this person's devices.
    publishLive: (frame) => publishHostEvent(TRANSCRIPT_LIVE_TOPIC, frame),
    // Read the way `session_timeline` reports it, so the device compares like with like.
    transcriptRevision: async (sessionId) => {
      const session = await getSession(sessionId)
      return session ? (session.transcriptRevision ?? 0) : undefined
    },
    applyEvent: (parts, event) => applyExternalAgentEventToParts(parts, event),
    pickAllowOption: (options) =>
      pickPermissionOptionId(
        "allow",
        Array.isArray(options) ? (options as AcpPermissionOption[]) : undefined
      ),
    newId: () => crypto.randomUUID(),
    now: Date.now,
    setTimer: (callback, ms) => {
      const handle = setTimeout(callback, ms)
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    },
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: deps.log,
  })
  runner = installed
  return async () => {
    if (runner === installed) runner = null
    await installed.closeAll()
    stopWatching()
    uninstallHost()
  }
}

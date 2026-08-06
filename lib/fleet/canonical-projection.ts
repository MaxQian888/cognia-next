import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import type { FleetOrigin, FleetSession } from "./types"

function originOf(envelope: AgentEventEnvelope): FleetOrigin {
  if (envelope.parentRunId) return "team"
  if (envelope.runtime.includes("workflow")) return "workflow"
  return "built-in"
}

export function projectCanonicalFleetSession(
  previous: FleetSession | undefined,
  envelope: AgentEventEnvelope,
  now = Date.now()
): FleetSession {
  const event = envelope.event as { kind?: string } & Record<string, unknown>
  const base: FleetSession = previous ?? {
    agent: "cognia",
    origin: originOf(envelope),
    lifecycleConfidence: "native",
    sessionId: envelope.sessionId,
    status: "working",
    cwd: null,
    projectName: null,
    lastPrompt: null,
    activity: null,
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
      interrupt: true,
    },
    startedAt: Date.parse(envelope.timestamp) || now,
    lastEventAt: now,
    toolUseCount: 0,
    turnCount: 0,
  }
  const next: FleetSession = { ...base, lastEventAt: now }

  switch (event.kind) {
    case "lifecycle":
      if (event.phase === "ended") {
        next.status = "ended"
        next.endedAt = now
        next.activity = null
        next.pendingPermission = null
      } else {
        next.status = "working"
        next.turnCount += 1
      }
      break
    case "tool-call":
      next.status = "working"
      next.toolUseCount += 1
      next.activity = {
        toolName: String(event.toolName ?? "tool"),
        detail: null,
      }
      break
    case "tool-result":
      next.activity = null
      break
    case "permission-request":
      next.status = "waiting-permission"
      next.pendingPermission = {
        requestId: String(event.requestId ?? ""),
        toolName: typeof event.toolName === "string" ? event.toolName : null,
        detail: null,
        requestedAt: now,
      }
      break
    case "failure":
      next.lastError = {
        kind: "turn",
        detail: typeof event.message === "string" ? event.message : null,
        at: now,
      }
      break
  }
  return next
}

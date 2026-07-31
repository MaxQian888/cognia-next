"use client"

import { getPluginEventHooks } from "@/lib/plugin"

import { registerLiveSession } from "./session-registry"
import { wireSessionToStore, type TerminalStoreLike } from "./spawn-orchestrator"
import {
  sshHostToConnectRequest,
  validateSshHostProfile,
  type SshHostProfile,
} from "./ssh-profiles"
import { SshTerminalSession } from "./ssh-session"

export type SshConnectOutcome =
  | {
      kind: "connected"
      sessionId: string
      hostKeyStatus: "learned" | "verified"
      hostKeyFingerprint: string
    }
  | { kind: "error"; message: string }

export async function connectSshFromDock(input: {
  profile: SshHostProfile
  rows: number
  cols: number
  projectId?: string
  store: TerminalStoreLike
  connect?: typeof SshTerminalSession.connect
}): Promise<SshConnectOutcome> {
  const request = sshHostToConnectRequest(input.profile, input.rows, input.cols, input.projectId)
  if (!request) {
    const field = validateSshHostProfile(input.profile) ?? "profile"
    return { kind: "error", message: `invalid SSH host profile: ${field}` }
  }

  let session: SshTerminalSession
  try {
    session = await (input.connect ?? SshTerminalSession.connect)(request)
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    }
  }

  const hooks = getPluginEventHooks()
  registerLiveSession(session)
  input.store.registerSession(session.info, { title: input.profile.name.trim() })
  wireSessionToStore(session, input.store, hooks)
  hooks.dispatchTerminalLifecycle({
    kind: "spawned",
    sessionId: session.info.id,
    projectId: session.info.projectId,
    extensionId: null,
  })
  return {
    kind: "connected",
    sessionId: session.info.id,
    hostKeyStatus: session.hostKeyStatus,
    hostKeyFingerprint: session.hostKeyFingerprint,
  }
}

"use client"

import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"

import { registerLiveSession } from "./session-registry"
import { wireSessionToStore, type TerminalStoreLike } from "./spawn-orchestrator"
import { buildForwardedConnectRequest } from "./ssh-forwarding"
import { type SshHostProfile } from "./ssh-profiles"
import { SshTerminalSession } from "./ssh-session"

export type SshConnectOutcome =
  | {
      kind: "connected"
      sessionId: string
      hostKeyStatus: "learned" | "verified"
      hostKeyFingerprint: string
    }
  | { kind: "error"; message: string }

/**
 * Whether a saved host can be launched by id alone.
 *
 * Callers outside the settings editor — the dock's shell picker today — have no
 * secret field, so a password host that has never been connected from settings
 * has nothing in the keyring to authenticate with. Catching that here turns an
 * opaque native "credential was not found" into an instruction the user can
 * act on, and keeps every id-based entry point honest about the same rule.
 */
export type SshHostLaunch =
  | { kind: "ready"; profile: SshHostProfile }
  | { kind: "unknownHost" }
  | { kind: "credentialRequired"; name: string }

export function resolveSshHostLaunch(
  hostId: string,
  hosts: readonly SshHostProfile[] | undefined
): SshHostLaunch {
  const profile = (hosts ?? []).find((host) => host.id === hostId)
  if (!profile) return { kind: "unknownHost" }
  // Key and agent auth both connect without anything in the keyring: an
  // unencrypted key needs no passphrase, and the agent holds its own material.
  if (profile.authMethod === "password" && !profile.credentialRef) {
    return { kind: "credentialRequired", name: profile.name }
  }
  return { kind: "ready", profile }
}

/**
 * Launch a saved host interactively.
 *
 * `allProfiles` is required rather than optional because a jump host is stored
 * as a profile id: without the set to resolve it against, a bastion-backed host
 * would silently connect direct — the one failure mode worth designing out, as
 * it would reach a machine the user did not mean to reach.
 */
export async function connectSshFromDock(input: {
  profile: SshHostProfile
  allProfiles: readonly SshHostProfile[]
  rows: number
  cols: number
  projectId?: string
  store: TerminalStoreLike
  connect?: typeof SshTerminalSession.connect
}): Promise<SshConnectOutcome> {
  const built = buildForwardedConnectRequest({
    profile: input.profile,
    allProfiles: input.allProfiles,
    rows: input.rows,
    cols: input.cols,
    projectId: input.projectId,
  })
  if (built.kind === "invalid") {
    return { kind: "error", message: `invalid SSH host profile: ${built.reason}` }
  }

  let session: SshTerminalSession
  try {
    session = await (input.connect ?? SshTerminalSession.connect)(built.request)
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

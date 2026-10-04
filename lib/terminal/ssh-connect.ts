"use client"

import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { isTauri } from "@/lib/platform/detect"

import { selectTerminalTransportChain } from "./pick-transport"
import { registerLiveSession } from "./session-registry"
import { spawnFromDock, wireSessionToStore, type TerminalStoreLike } from "./spawn-orchestrator"
import { buildForwardedConnectRequest, resolveJumpChain } from "./ssh-forwarding"
import { type SshHostProfile } from "./ssh-profiles"
import { SshTerminalSession } from "./ssh-session"

export type SshConnectOutcome =
  | {
      kind: "connected"
      sessionId: string
      /**
       * `null` when the host made the connection and did not tell us what it
       * verified.
       *
       * A remote spawn goes over the `/ws/terminal` binary plane, whose frames
       * carry no host-key fields at all: the host records the verdict on its
       * own session row and it never crosses the wire. Reporting `learned`
       * there would be inventing a trust decision nobody observed.
       */
      hostKeyStatus: "learned" | "verified" | null
      hostKeyFingerprint: string | null
    }
  | { kind: "error"; message: string }

/**
 * Whether a saved host can be launched by id alone.
 *
 * Callers outside the settings editor, the dock's shell picker today, have no
 * secret field, so a password host that has never been connected from settings
 * has nothing in the keyring to authenticate with. Catching that here turns an
 * opaque native "credential was not found" into an instruction the user can
 * act on, and keeps every id-based entry point honest about the same rule.
 *
 * The rule covers every hop, not only the target. A bastion authenticates on
 * its own account against its own keyring entry (ADR-0082 §9), so a password
 * bastion with nothing stored failed with the native "SSH password credential
 * is missing" after the target itself had passed this check. `bastion` names
 * the hop that is missing one, so the fix can be pointed at the right profile.
 *
 * A chain that cannot be walked (a missing profile, a cycle, or more than five
 * hops) is its own answer rather than `ready`: `buildForwardedConnectRequest`
 * refuses it anyway, and saying so before a click is what lets a caller name
 * the reason instead of printing `invalid SSH host profile: jumpChain`.
 */
export type SshHostLaunch =
  | { kind: "ready"; profile: SshHostProfile }
  | { kind: "unknownHost" }
  | {
      kind: "credentialRequired"
      /** The target's display name. */
      name: string
      /** The profile that has no stored credential: the target or a bastion. */
      hostId: string
      /** Set when the hop missing a credential is a bastion, not the target. */
      bastion: { id: string; name: string } | null
    }
  | { kind: "chainBroken"; name: string; hostId: string }

function needsStoredCredential(profile: SshHostProfile): boolean {
  // Key and agent auth both connect without anything in the keyring: an
  // unencrypted key needs no passphrase, and the agent holds its own material.
  return profile.authMethod === "password" && !profile.credentialRef
}

export function resolveSshHostLaunch(
  hostId: string,
  hosts: readonly SshHostProfile[] | undefined
): SshHostLaunch {
  const saved = hosts ?? []
  const profile = saved.find((host) => host.id === hostId)
  if (!profile) return { kind: "unknownHost" }
  const chain = resolveJumpChain(profile, saved)
  if (!chain) return { kind: "chainBroken", name: profile.name, hostId: profile.id }
  if (needsStoredCredential(profile)) {
    return { kind: "credentialRequired", name: profile.name, hostId: profile.id, bastion: null }
  }
  // Outermost bastion first, the order a connection would fail in.
  for (const hop of chain.slice(0, -1)) {
    if (needsStoredCredential(hop)) {
      return {
        kind: "credentialRequired",
        name: profile.name,
        hostId: hop.id,
        bastion: { id: hop.id, name: hop.name },
      }
    }
  }
  return { kind: "ready", profile }
}

/**
 * The native side's answer when a profile id names nothing it holds.
 *
 * Matched as a substring rather than a code, because the host reports it as
 * plain text. It is the one remote failure with a specific, actionable cause,
 * and the bare string does not say whose profile list is being consulted.
 */
const UNKNOWN_PROFILE_MARKER = "unknown terminal profile"

/** Whether a failed remote spawn was the host not knowing the named profile. */
export function isUnknownHostProfileError(message: string): boolean {
  return message.toLowerCase().includes(UNKNOWN_PROFILE_MARKER)
}

/**
 * Marker for the reworded "this host has no such profile" failure.
 *
 * A marker rather than a sentence because this module has no translator. The
 * three call sites all have one, and each already decides where a failure
 * goes, so they render it.
 */
export const SSH_PROFILE_NOT_ON_HOST = "ssh_profile_not_on_host"

/**
 * Launch a saved host interactively.
 *
 * `allProfiles` is required rather than optional because a jump host is stored
 * as a profile id: without the set to resolve it against, a bastion-backed host
 * would silently connect direct, which is the one failure mode worth designing
 * out, as it would reach a machine the user did not mean to reach.
 *
 * ## Two paths, one entry point
 *
 * **On the desktop** the request is built here, forwards and jump chain
 * included, and handed to `ssh_terminal_spawn`. Credentials are resolved
 * natively from this machine's keyring and the host-key verdict comes back with
 * the session.
 *
 * **Everywhere else** the connection is made *by the host*, and all this sends
 * is the profile id. `TerminalHost::spawn_synchronized_profile` looks the id up
 * in the `ssh_profiles` map its own desktop synced, and connects with
 * credentials that never leave it. That is what ADR-0082 describes, and what
 * `packages/agent-config-types` states outright: a phone or LAN client naming a
 * profile id gets a shell and never a tunnel. The path has been live in Rust
 * the whole time. Three UI gates are what made SSH look desktop-only.
 *
 * ## The desktop always dials its own profiles
 *
 * The branch is "is this the desktop", not "which terminal transport is
 * preferred right now". The two used to be the same question, until a desktop
 * could drive a remote Cognia host (ADR-0082): with a host active the preferred
 * transport is `ws`, and this function sent the profile id to the remote host.
 * That host only holds the SSH profiles its OWN desktop synced, under ids of
 * the form `ssh-N`, so the request either failed with "profile not on host" or,
 * worse, matched a different machine's `ssh-1` and opened a shell on a server
 * the user never picked, with somebody else's credential.
 *
 * The profile, its jump chain and its keyring entry all live on this desktop,
 * and `SshTerminalSession` talks to this desktop's terminal host directly
 * (`invoke`, not `transport`), so the session is dialed from here whichever
 * host the rest of the window is pointed at. Off the desktop there is no local
 * keyring and no native client, so the host-mediated path is the only one.
 */
export async function connectSshFromDock(input: {
  profile: SshHostProfile
  allProfiles: readonly SshHostProfile[]
  rows: number
  cols: number
  projectId?: string
  store: TerminalStoreLike
  connect?: typeof SshTerminalSession.connect
  /** Test seam for the host-mediated path. */
  spawn?: typeof spawnFromDock
  /** Test seam. Defaults to the live transport chain. */
  transportChain?: typeof selectTerminalTransportChain
  /**
   * Test seam for "is this the desktop". Defaults to `isTauri()`. The live
   * chain's `tauri-channel` head implies the same answer and is accepted too,
   * so a caller that only stubs the chain still reaches the native path.
   */
  dialsLocally?: () => boolean
}): Promise<SshConnectOutcome> {
  const chain = (input.transportChain ?? selectTerminalTransportChain)()
  const local = (input.dialsLocally ?? isTauri)() || chain[0] === "tauri-channel"
  if (!local) {
    if (chain.length === 0) {
      return { kind: "error", message: "no terminal host is reachable from this shell" }
    }
    return connectThroughHost(input)
  }

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

/**
 * Ask the host to make the connection, naming only the profile.
 *
 * Goes through `spawnFromDock` rather than a second copy of its work: the hook
 * veto, the spawn timeout, the live-session registry and the store wiring are
 * the same for an SSH session as for any other, and duplicating them here is
 * how the two paths would drift.
 *
 * Nothing about the host is sent. Not the address, not the port, not the jump
 * chain, and above all not the credential. The host resolves all of it from the
 * profile its own desktop registered. `shell` is empty for the same reason: the
 * remote Spawn frame carries a profile id and nothing else, so any value here
 * is dropped in transit, and putting one in the hook payload would describe a
 * shell nobody asked for.
 */
async function connectThroughHost(input: {
  profile: SshHostProfile
  rows: number
  cols: number
  projectId?: string
  store: TerminalStoreLike
  spawn?: typeof spawnFromDock
}): Promise<SshConnectOutcome> {
  const outcome = await (input.spawn ?? spawnFromDock)({
    req: {
      profileId: input.profile.id,
      shell: "",
      rows: input.rows,
      cols: input.cols,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    store: input.store,
    title: input.profile.name.trim(),
  })

  if (outcome.kind === "denied") {
    return { kind: "error", message: "the spawn was denied by a plugin hook" }
  }
  if (outcome.kind === "error") {
    /**
     * A host only knows the SSH profiles its own desktop renderer synced. A
     * headless `cognia-server` has no renderer and therefore has none, so this
     * is a routine outcome rather than a corrupt state, and the bare native
     * string does not say whose list is being consulted.
     */
    if (isUnknownHostProfileError(outcome.message)) {
      return { kind: "error", message: `${SSH_PROFILE_NOT_ON_HOST}:${input.profile.name}` }
    }
    return outcome
  }
  return {
    kind: "connected",
    sessionId: outcome.sessionId,
    // The wire carries no host-key fields. See `SshConnectOutcome`.
    hostKeyStatus: null,
    hostKeyFingerprint: null,
  }
}

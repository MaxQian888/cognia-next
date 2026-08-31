"use client"

/**
 * Is this saved SSH host actually reachable, right now?
 *
 * Nothing ever asked, so `/devices` painted every SSH row `unknown` forever
 * while every other machine class carried a real presence signal. Every
 * comparable product offers this before you commit to a session: JetBrains
 * Gateway calls it Test Connection, VS Code's Remote Explorer resolves the
 * host before opening a window.
 *
 * A probe is a real connection, not a ping. That is the honest way to answer
 * the question, and it is the same path a session takes, so it cannot pass
 * while a session would fail. It also means real side effects, which the UI
 * states rather than hides:
 *
 *   * It **dials the whole jump chain.** A bastion-backed host that only
 *     answers direct is not reachable, so testing the target alone would
 *     report a success the user cannot use.
 *   * It **learns the host key on first contact**, through the same silent
 *     TOFU path a normal connect uses. There is no probe-only mode in the
 *     native layer, and adding a second trust path is worse than one.
 *   * It authenticates, so it can raise an ssh-agent passphrase prompt, and it
 *     lands in the target's and every bastion's auth log.
 *
 * Two things it deliberately does not do. It never binds a port: forwards are
 * stripped before the request is built, because a test that opens a tunnel has
 * changed the machine it was only supposed to ask about. And it never reaches
 * the terminal store, so no tab appears and nothing is registered as a live
 * session.
 */

import { buildForwardedConnectRequest, type ForwardedRequestError } from "./ssh-forwarding"
import type { SshHostProfile } from "./ssh-profiles"
import { SshTerminalSession } from "./ssh-session"

/** Geometry the session never uses. It is killed before anything is drawn. */
const PROBE_ROWS = 24
const PROBE_COLS = 80

export type SshProbeOutcome =
  | {
      kind: "reachable"
      /** `learned` means this probe is what wrote the key into `known_hosts`. */
      hostKeyStatus: "learned" | "verified"
      hostKeyFingerprint: string
    }
  /** The host, or a bastion on the way to it, refused or could not be reached. */
  | { kind: "unreachable"; message: string }
  /**
   * The profile itself cannot produce a request. Kept apart from `unreachable`
   * because no amount of retrying fixes it and the remedy is a different one:
   * the machine may be perfectly healthy.
   */
  | { kind: "invalid"; reason: ForwardedRequestError }

export interface ProbeSshHostInput {
  profile: SshHostProfile
  /**
   * Required, not optional, for the same reason `connectSshFromDock` requires
   * it: a jump host is stored as a profile id, so without the set to resolve
   * against, a bastion-backed host would be probed direct and report on a
   * machine the user did not name.
   */
  allProfiles: readonly SshHostProfile[]
  /** Test seam. Defaults to the real native connect. */
  connect?: typeof SshTerminalSession.connect
}

export async function probeSshHost(input: ProbeSshHostInput): Promise<SshProbeOutcome> {
  const built = buildForwardedConnectRequest({
    // Forwards stripped at the source rather than filtered downstream, so
    // there is no path by which a probe binds a port.
    profile: { ...input.profile, localForwards: [], remoteForwards: [] },
    allProfiles: input.allProfiles,
    rows: PROBE_ROWS,
    cols: PROBE_COLS,
  })
  if (built.kind === "invalid") return { kind: "invalid", reason: built.reason }

  let session: SshTerminalSession
  try {
    session = await (input.connect ?? SshTerminalSession.connect)(built.request)
  } catch (error) {
    return {
      kind: "unreachable",
      message: error instanceof Error ? error.message : String(error),
    }
  }

  try {
    return {
      kind: "reachable",
      hostKeyStatus: session.hostKeyStatus,
      hostKeyFingerprint: session.hostKeyFingerprint,
    }
  } finally {
    // The answer is already in hand, so a kill that fails must not turn a
    // successful probe into a failed one. It is still awaited: leaving a live
    // shell open on a remote machine because a test succeeded is worse than
    // the extra moment it costs.
    await session.kill().catch(() => undefined)
  }
}

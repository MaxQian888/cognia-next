/**
 * Jump hosts and port forwarding: validation, display, and the connect request
 * that carries them to the native side.
 *
 * Nothing here builds an OpenSSH command line. There is no `ssh` binary in the
 * loop — `crates/cognia-terminal/src/ssh.rs` opens every hop and every tunnel
 * in-process with russh, so the wire shape is the resolved
 * [`SshConnectRequest`], not a string of flags.
 *
 * The split from `ssh-profiles.ts` is deliberate and one-way. That module owns
 * the persisted shape and the plain, forwarding-free request used to
 * synchronize profiles to the terminal host; this one owns everything a
 * forward implies. Host-synchronized profiles therefore cannot carry tunnels
 * even by accident — a phone or LAN client naming a profile id gets a shell,
 * never a listening port on the desktop (ADR-0082 §8).
 */

import {
  sshHostToConnectRequest,
  validateSshHostProfile,
  type LocalForward,
  type RemoteForward,
  type SshConnectRequest,
  type SshHostProfile,
  type SshHostValidationField,
  type SshJumpHop,
} from "./ssh-profiles"

export type { LocalForward, RemoteForward, SshJumpHop } from "./ssh-profiles"
export { FORWARD_BIND_ADDRESS } from "./ssh-profiles"

/** Bastions a chain may traverse before the target. Matches the native limit. */
export const MAX_JUMP_DEPTH = 5

export type ForwardValidationError =
  | "port_out_of_range"
  | "host_empty"
  | "host_invalid"
  | "duplicate_local_port"
  | "duplicate_remote_port"
  | null

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535
}

function hostProblem(host: string): ForwardValidationError {
  if (!host.trim()) return "host_empty"
  // The host travels verbatim in the SSH `direct-tcpip` request; embedded
  // whitespace only ever means a paste accident.
  if (/\s/.test(host)) return "host_invalid"
  return null
}

/**
 * Validate a local forward.
 *
 * `takenLocalPorts` is every port already claimed by another rule on the same
 * profile: two listeners cannot share one port, and the second bind would fail
 * at connect time with an OS error rather than here where it can be shown.
 */
export function validateLocalForward(
  forward: LocalForward,
  takenLocalPorts?: readonly number[]
): ForwardValidationError {
  if (!isPort(forward.localPort) || !isPort(forward.remotePort)) return "port_out_of_range"
  const host = hostProblem(forward.remoteHost)
  if (host) return host
  if (takenLocalPorts?.includes(forward.localPort)) return "duplicate_local_port"
  return null
}

/** Validate a remote forward. `takenRemotePorts` mirrors the local rule above. */
export function validateRemoteForward(
  forward: RemoteForward,
  takenRemotePorts?: readonly number[]
): ForwardValidationError {
  if (!isPort(forward.remotePort) || !isPort(forward.localPort)) return "port_out_of_range"
  const host = hostProblem(forward.localHost)
  if (host) return host
  if (takenRemotePorts?.includes(forward.remotePort)) return "duplicate_remote_port"
  return null
}

/** `127.0.0.1:8080 → db.internal:5432` */
export function formatLocalForward(forward: LocalForward): string {
  return `127.0.0.1:${forward.localPort} → ${forward.remoteHost}:${forward.remotePort}`
}

/** `remote 127.0.0.1:8080 → localhost:3000` */
export function formatRemoteForward(forward: RemoteForward): string {
  return `remote 127.0.0.1:${forward.remotePort} → ${forward.localHost}:${forward.localPort}`
}

/**
 * Order the hops that lead to `target`, outermost bastion first, target last.
 *
 * Returns `null` for a chain that cannot be walked — a missing profile, a cycle,
 * or one longer than [`MAX_JUMP_DEPTH`] — because a partially resolved chain
 * would connect to the wrong machine rather than fail.
 */
export function resolveJumpChain(
  target: SshHostProfile,
  allProfiles: readonly SshHostProfile[],
  maxDepth = MAX_JUMP_DEPTH
): SshHostProfile[] | null {
  const chain: SshHostProfile[] = []
  let current: SshHostProfile | undefined = target
  const visited = new Set<string>()

  while (current?.jumpHostId) {
    if (visited.has(current.jumpHostId)) return null
    if (chain.length >= maxDepth) return null
    visited.add(current.jumpHostId)
    const jumpHostId: string = current.jumpHostId
    const jump = allProfiles.find((profile) => profile.id === jumpHostId)
    if (!jump) return null
    chain.unshift(jump)
    current = jump
  }

  chain.push(target)
  return chain
}

/**
 * Profiles that may be picked as `profile`'s jump host.
 *
 * Excludes the profile itself and anything whose own chain already passes
 * through it, so the Select cannot offer a choice that resolves to `null`.
 */
export function jumpHostCandidates(
  profile: SshHostProfile,
  allProfiles: readonly SshHostProfile[]
): SshHostProfile[] {
  return allProfiles.filter((candidate) => {
    if (candidate.id === profile.id) return false
    const chain = resolveJumpChain(candidate, allProfiles)
    return chain !== null && !chain.some((hop) => hop.id === profile.id)
  })
}

function toJumpHop(profile: SshHostProfile): SshJumpHop {
  return {
    host: profile.host.trim(),
    port: profile.port,
    username: profile.username.trim(),
    authMethod: profile.authMethod,
    credentialRef: profile.credentialRef,
    privateKeyPath: profile.privateKeyPath?.trim() || undefined,
  }
}

/**
 * Why a launch was refused. The profile fields are passed through from
 * `validateSshHostProfile` rather than flattened into one "invalid profile",
 * because "host" and "jumpChain" send the user to different fields.
 */
export type ForwardedRequestError =
  SshHostValidationField | "profile" | "jumpChain" | "localForward" | "remoteForward"

export type ForwardedRequest =
  { kind: "ok"; request: SshConnectRequest } | { kind: "invalid"; reason: ForwardedRequestError }

/**
 * Build the connect request for an interactive launch, tunnels included.
 *
 * This is the only place forwarding reaches the wire. Disabled rules are
 * dropped here rather than passed along with a flag, so a rule the user turned
 * off cannot be revived by a native-side default.
 */
export function buildForwardedConnectRequest(input: {
  profile: SshHostProfile
  allProfiles: readonly SshHostProfile[]
  rows: number
  cols: number
  projectId?: string
}): ForwardedRequest {
  const base = sshHostToConnectRequest(input.profile, input.rows, input.cols, input.projectId)
  if (!base) {
    return { kind: "invalid", reason: validateSshHostProfile(input.profile) ?? "profile" }
  }

  const chain = resolveJumpChain(input.profile, input.allProfiles)
  if (!chain) return { kind: "invalid", reason: "jumpChain" }
  // `resolveJumpChain` ends with the target; the hops are what precedes it.
  const hops = chain.slice(0, -1)
  for (const hop of hops) {
    // A bastion authenticates on its own account, so it must be as complete as
    // any host we would connect to directly.
    if (validateSshHopProfile(hop)) return { kind: "invalid", reason: "jumpChain" }
  }

  const localForwards = (input.profile.localForwards ?? []).filter((rule) => rule.enabled)
  const seenLocal: number[] = []
  for (const rule of localForwards) {
    if (validateLocalForward(rule, seenLocal)) return { kind: "invalid", reason: "localForward" }
    seenLocal.push(rule.localPort)
  }

  const remoteForwards = (input.profile.remoteForwards ?? []).filter((rule) => rule.enabled)
  const seenRemote: number[] = []
  for (const rule of remoteForwards) {
    if (validateRemoteForward(rule, seenRemote)) return { kind: "invalid", reason: "remoteForward" }
    seenRemote.push(rule.remotePort)
  }

  return {
    kind: "ok",
    request: {
      ...base,
      jumpChain: hops.map(toJumpHop),
      localForwards,
      remoteForwards,
    },
  }
}

function validateSshHopProfile(hop: SshHostProfile): boolean {
  if (!hop.host.trim() || /\s/.test(hop.host)) return true
  if (!hop.username.trim() || /\s/.test(hop.username)) return true
  if (!Number.isInteger(hop.port) || hop.port < 1 || hop.port > 65_535) return true
  if (hop.authMethod === "privateKey" && !hop.privateKeyPath?.trim()) return true
  return false
}

function nextForwardId(prefix: string, existing: readonly { id: string }[]): string {
  const used = new Set(existing.map((rule) => rule.id))
  let next = existing.length + 1
  while (used.has(`${prefix}-${next}`)) next += 1
  return `${prefix}-${next}`
}

/** A new `-L` rule, on by default: it only ever listens on this machine. */
export function newLocalForward(existing: readonly LocalForward[]): LocalForward {
  return {
    id: nextForwardId("lfwd", existing),
    localPort: 8080,
    remoteHost: "localhost",
    remotePort: 80,
    enabled: true,
  }
}

/**
 * A new `-R` rule, off by default.
 *
 * A remote forward opens a listening socket on someone else's machine and
 * points it back here, so it starts inert and the user turns it on deliberately.
 */
export function newRemoteForward(existing: readonly RemoteForward[]): RemoteForward {
  return {
    id: nextForwardId("rfwd", existing),
    remotePort: 8080,
    localHost: "localhost",
    localPort: 3000,
    enabled: false,
  }
}

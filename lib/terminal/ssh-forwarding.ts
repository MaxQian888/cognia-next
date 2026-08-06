/**
 * SSH jump host and port forwarding extensions.
 *
 * Extends the existing `SshHostProfile` with:
 *  - Jump host chains (ProxyJump)
 *  - Local port forwards (-L)
 *  - Remote port forwards (-R)
 *
 * These produce the command-line flags or russh channel config that the
 * Rust SSH backend uses when establishing the connection.
 */

import type { SshHostProfile } from "./ssh-profiles"

/** A local port forward (-L): listen locally, forward to remote. */
export interface LocalForward {
  /** Local port to listen on. */
  localPort: number
  /** Remote host to forward to (from the SSH server's perspective). */
  remoteHost: string
  /** Remote port to forward to. */
  remotePort: number
  /** Optional bind address (defaults to "127.0.0.1"). */
  bindAddress?: string
}

/** A remote port forward (-R): listen on remote, forward to local. */
export interface RemoteForward {
  /** Remote port to listen on. */
  remotePort: number
  /** Local host to forward to. */
  localHost: string
  /** Local port to forward to. */
  localPort: number
  /** Optional remote bind address (defaults to "127.0.0.1"). */
  bindAddress?: string
}

/** Extended SSH profile with jump host + forwarding. */
export interface SshExtendedProfile extends SshHostProfile {
  /** ID of another SshHostProfile to use as a jump host. Null = direct. */
  jumpHostId: string | null
  /** Local port forwards to establish after connection. */
  localForwards: LocalForward[]
  /** Remote port forwards to establish after connection. */
  remoteForwards: RemoteForward[]
}

/** Validation result for port forwarding rules. */
export type ForwardValidationError =
  "port_out_of_range" | "host_empty" | "duplicate_local_port" | null

/**
 * Validate a local forward rule.
 */
export function validateLocalForward(
  forward: LocalForward,
  existingLocalPorts?: number[]
): ForwardValidationError {
  if (forward.localPort < 1 || forward.localPort > 65535) return "port_out_of_range"
  if (forward.remotePort < 1 || forward.remotePort > 65535) return "port_out_of_range"
  if (!forward.remoteHost.trim()) return "host_empty"
  if (existingLocalPorts?.includes(forward.localPort)) return "duplicate_local_port"
  return null
}

/**
 * Validate a remote forward rule.
 */
export function validateRemoteForward(forward: RemoteForward): ForwardValidationError {
  if (forward.remotePort < 1 || forward.remotePort > 65535) return "port_out_of_range"
  if (forward.localPort < 1 || forward.localPort > 65535) return "port_out_of_range"
  if (!forward.localHost.trim()) return "host_empty"
  return null
}

/**
 * Format a local forward for display (e.g. "8080 → remotehost:80").
 */
export function formatLocalForward(fwd: LocalForward): string {
  const bind = fwd.bindAddress && fwd.bindAddress !== "127.0.0.1" ? `${fwd.bindAddress}:` : ""
  return `${bind}${fwd.localPort} → ${fwd.remoteHost}:${fwd.remotePort}`
}

/**
 * Format a remote forward for display (e.g. "remote:8080 → localhost:3000").
 */
export function formatRemoteForward(fwd: RemoteForward): string {
  const bind = fwd.bindAddress && fwd.bindAddress !== "127.0.0.1" ? `${fwd.bindAddress}:` : ""
  return `${bind}${fwd.remotePort} → ${fwd.localHost}:${fwd.localPort}`
}

/**
 * Build the SSH `-L` flag string for a local forward.
 */
export function buildLocalForwardFlag(fwd: LocalForward): string {
  const bind = fwd.bindAddress ?? "127.0.0.1"
  return `-L ${bind}:${fwd.localPort}:${fwd.remoteHost}:${fwd.remotePort}`
}

/**
 * Build the SSH `-R` flag string for a remote forward.
 */
export function buildRemoteForwardFlag(fwd: RemoteForward): string {
  const bind = fwd.bindAddress ?? "127.0.0.1"
  return `-R ${bind}:${fwd.remotePort}:${fwd.localHost}:${fwd.localPort}`
}

/**
 * Resolve a jump host chain from a set of profiles.
 * Returns the ordered list of profiles from outermost jump to the target,
 * or null if a referenced jump host doesn't exist (broken chain).
 */
export function resolveJumpChain(
  targetProfile: SshExtendedProfile,
  allProfiles: readonly SshExtendedProfile[],
  maxDepth = 5
): SshExtendedProfile[] | null {
  const chain: SshExtendedProfile[] = []
  let current: SshExtendedProfile | undefined = targetProfile
  const visited = new Set<string>()

  while (current?.jumpHostId) {
    if (visited.has(current.jumpHostId)) {
      // Circular reference detected
      return null
    }
    if (chain.length >= maxDepth) {
      // Chain too deep
      return null
    }
    visited.add(current.jumpHostId)
    const jump = allProfiles.find((p) => p.id === current!.jumpHostId)
    if (!jump) return null // broken chain
    chain.unshift(jump)
    current = jump
  }

  chain.push(targetProfile)
  return chain
}

/**
 * Build the `-J` (ProxyJump) flag for an SSH command.
 * The chain should be ordered from outermost to target (excluding the target).
 */
export function buildProxyJumpFlag(
  jumpHosts: readonly Pick<SshHostProfile, "username" | "host" | "port">[]
): string {
  if (jumpHosts.length === 0) return ""
  const specs = jumpHosts.map((h) => {
    const port = h.port !== 22 ? `:${h.port}` : ""
    return `${h.username}@${h.host}${port}`
  })
  return `-J ${specs.join(",")}`
}

/**
 * Persisted SSH host metadata and the secret-free request passed to Rust.
 *
 * Passwords and private-key passphrases never belong in this shape. The
 * optional `credentialRef` points at the `cognia-ssh` OS-keyring namespace.
 */

/**
 * `agent` delegates the signature to a running `ssh-agent`, so it needs neither
 * a `credentialRef` nor a `privateKeyPath` — the agent holds the key material
 * and never surrenders it.
 */
export type SshAuthMethod = "password" | "privateKey" | "agent"

/**
 * Every tunnel this app opens binds the loopback interface, on both ends.
 *
 * A forward reachable from the LAN turns one trusted machine into an open relay
 * for the other, so the address is a constant rather than a setting: there is no
 * shape a user could persist that would widen it. See ADR-0082 §8 (SSH
 * forwarding amendment).
 */
export const FORWARD_BIND_ADDRESS = "127.0.0.1"

/**
 * A local forward (`-L`): this machine listens, the server dials out.
 *
 * `enabled` is required and read as a plain boolean, so a rule persisted before
 * the field existed (or truncated by a partial write) reads as `false` and stays
 * shut. Both directions fail closed the same way.
 */
export interface LocalForward {
  id: string
  localPort: number
  /** Resolved by the SSH server, not by this machine. */
  remoteHost: string
  remotePort: number
  enabled: boolean
}

/** A remote forward (`-R`): the server listens, this machine dials out. */
export interface RemoteForward {
  id: string
  remotePort: number
  localHost: string
  localPort: number
  enabled: boolean
}

/**
 * One hop of a resolved jump chain, ordered outermost first.
 *
 * The renderer resolves profile ids into hops because ids are a renderer-side
 * concept; the native side only ever sees addresses and the keyring references
 * that unlock them. Each hop authenticates and is TOFU-verified in its own
 * right — a bastion is a server you trust separately, not a transparent pipe.
 */
export interface SshJumpHop {
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  credentialRef?: string
  privateKeyPath?: string
}

export interface SshHostProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  privateKeyPath?: string
  credentialRef?: string
  /** Id of another profile to reach this host through. */
  jumpHostId?: string | null
  localForwards?: LocalForward[]
  remoteForwards?: RemoteForward[]
}

export interface SshConnectRequest {
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  credentialRef?: string
  privateKeyPath?: string
  rows: number
  cols: number
  projectId?: string
  profileId: string
  displayName: string
  jumpChain?: SshJumpHop[]
  localForwards?: LocalForward[]
  remoteForwards?: RemoteForward[]
}

export type SshHostValidationField = "name" | "host" | "port" | "username" | "privateKeyPath"

export function validateSshHostProfile(profile: SshHostProfile): SshHostValidationField | null {
  if (!profile.name.trim()) return "name"
  if (!profile.host.trim() || /\s/.test(profile.host)) return "host"
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65_535) return "port"
  if (!profile.username.trim() || /\s/.test(profile.username)) return "username"
  if (profile.authMethod === "privateKey" && !profile.privateKeyPath?.trim()) {
    return "privateKeyPath"
  }
  return null
}

export function sshHostToConnectRequest(
  profile: SshHostProfile,
  rows: number,
  cols: number,
  projectId?: string
): SshConnectRequest | null {
  if (validateSshHostProfile(profile)) return null
  return {
    host: profile.host.trim(),
    port: profile.port,
    username: profile.username.trim(),
    authMethod: profile.authMethod,
    credentialRef: profile.credentialRef,
    privateKeyPath: profile.privateKeyPath?.trim() || undefined,
    rows: Math.max(1, Math.floor(rows)),
    cols: Math.max(1, Math.floor(cols)),
    projectId,
    profileId: profile.id,
    displayName: profile.name.trim(),
  }
}

export function nextSshHostId(existing: readonly SshHostProfile[] | undefined): string {
  const used = new Set((existing ?? []).map((profile) => profile.id))
  let next = (existing?.length ?? 0) + 1
  while (used.has(`ssh-${next}`)) next += 1
  return `ssh-${next}`
}

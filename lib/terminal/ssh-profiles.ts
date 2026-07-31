/**
 * Persisted SSH host metadata and the secret-free request passed to Rust.
 *
 * Passwords and private-key passphrases never belong in this shape. The
 * optional `credentialRef` points at the `cognia-ssh` OS-keyring namespace.
 */

export type SshAuthMethod = "password" | "privateKey"

export interface SshHostProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  privateKeyPath?: string
  credentialRef?: string
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

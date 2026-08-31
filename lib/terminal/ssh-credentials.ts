"use client"

/**
 * SSH secrets for saved hosts, written here and read only by the host process.
 *
 * There is deliberately no reader on this side. `crates/cognia-terminal/src/ssh.rs`
 * resolves the credential natively from the same keyring namespace at connect
 * time, so a password never round-trips through the renderer, and the editor
 * never prefills a stored secret back into a form field.
 */

import { createLocalKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"

export const SSH_CREDENTIAL_NAMESPACE = "cognia-ssh"

export interface SshCredential {
  password?: string
  passphrase?: string
}

let storeOverride: KeyringStore | null = null

function store(): KeyringStore {
  return storeOverride ?? createLocalKeyringStore(SSH_CREDENTIAL_NAMESPACE)
}

function validateProfileId(profileId: string): string {
  const id = profileId.trim()
  if (!id || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error("invalid SSH profile id")
  }
  return id
}

export async function saveSshCredential(
  profileId: string,
  credential: SshCredential
): Promise<void> {
  const id = validateProfileId(profileId)
  const password = credential.password
  const passphrase = credential.passphrase
  if (!password && !passphrase) throw new Error("SSH credential must not be empty")
  await store().save(id, JSON.stringify({ password, passphrase }))
}

export async function clearSshCredential(profileId: string): Promise<void> {
  await store().delete(validateProfileId(profileId))
}

/** Test seam; production callers never override the keyring backend. */
export function __setSshCredentialStore(next: KeyringStore | null): void {
  storeOverride = next
}

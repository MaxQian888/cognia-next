"use client"

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

function parseCredential(raw: string): SshCredential {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("invalid SSH credential payload")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid SSH credential payload")
  }
  const candidate = value as Record<string, unknown>
  if (
    (candidate.password !== undefined && typeof candidate.password !== "string") ||
    (candidate.passphrase !== undefined && typeof candidate.passphrase !== "string")
  ) {
    throw new Error("invalid SSH credential payload")
  }
  const credential: SshCredential = {}
  if (candidate.password !== undefined) credential.password = candidate.password as string
  if (candidate.passphrase !== undefined) credential.passphrase = candidate.passphrase as string
  if (!credential.password && !credential.passphrase) {
    throw new Error("invalid SSH credential payload")
  }
  return credential
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

export async function loadSshCredential(profileId: string): Promise<SshCredential | null> {
  const raw = await store().load(validateProfileId(profileId))
  return raw === null ? null : parseCredential(raw)
}

export async function clearSshCredential(profileId: string): Promise<void> {
  await store().delete(validateProfileId(profileId))
}

/** Test seam; production callers never override the keyring backend. */
export function __setSshCredentialStore(next: KeyringStore | null): void {
  storeOverride = next
}

/**
 * Credential + config writers for `cognia-agent auth` / `config`.
 *
 * Secrets land in `~/.cognia/credentials.json` with 0600 perms so a shared
 * `config.json` never has to carry an API key. All filesystem effects go
 * through an injectable {@link CredentialsFs} so the writers unit-test without
 * touching real disk.
 */

import fs from "node:fs"
import path from "node:path"

import {
  CLI_SEARCH_PROVIDER_IDS,
  credentialsFileSchema,
  type CliSearchProviderId,
  type CredentialsFile,
} from "./schema"
import { credentialsPath } from "./load"

export interface CredentialsFs {
  read: (absPath: string) => string | null
  write: (absPath: string, content: string, mode: number) => void
  mkdirp: (dir: string) => void
  dirname: (absPath: string) => string
}

/** Real-fs implementation. */
export const realCredentialsFs: CredentialsFs = {
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  write: (p, content, mode) => {
    fs.writeFileSync(p, content, { mode })
    // writeFileSync's mode only applies on create; enforce on existing files too.
    try {
      fs.chmodSync(p, mode)
    } catch {
      // Best-effort — e.g. Windows ignores chmod; perms aren't enforced there.
    }
  },
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true })
  },
  dirname: (p) => path.dirname(p),
}

/** Owner read/write only. */
export const CREDENTIALS_MODE = 0o600

function readCredentials(home: string, fsx: CredentialsFs): CredentialsFile {
  const raw = fsx.read(credentialsPath(home))
  if (raw === null) return {}
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`credentials.json: invalid JSON — ${(err as Error).message}`)
  }
  return credentialsFileSchema.parse(json)
}

/** Which secret a credential carries — a metered API key or a subscription token. */
export type CredentialKind = "apiKey" | "authToken"

/**
 * Store (or replace) a secret for `providerId`, preserving every other
 * provider's credentials AND the provider's other secret kind (so saving a
 * subscription token never wipes an existing API key, and vice versa). Returns
 * the absolute path written.
 */
export function setCredential(
  home: string,
  providerId: string,
  secret: string,
  fsx: CredentialsFs = realCredentialsFs,
  opts: { kind?: CredentialKind } = {}
): string {
  const kind = opts.kind ?? "apiKey"
  if (!secret.trim()) throw new Error(`${kind} must not be empty`)
  const current = readCredentials(home, fsx)
  const existing = current.providers?.[providerId] ?? {}
  const next: CredentialsFile = {
    ...current,
    providers: { ...(current.providers ?? {}), [providerId]: { ...existing, [kind]: secret } },
  }
  const target = credentialsPath(home)
  fsx.mkdirp(fsx.dirname(target))
  fsx.write(target, JSON.stringify(next, null, 2) + "\n", CREDENTIALS_MODE)
  return target
}

/** Remove the stored API key for `providerId`. No-op when absent. */
export function deleteCredential(
  home: string,
  providerId: string,
  fsx: CredentialsFs = realCredentialsFs
): void {
  const current = readCredentials(home, fsx)
  if (!current.providers?.[providerId]) return
  const providers = { ...current.providers }
  delete providers[providerId]
  const target = credentialsPath(home)
  fsx.mkdirp(fsx.dirname(target))
  fsx.write(target, JSON.stringify({ ...current, providers }, null, 2) + "\n", CREDENTIALS_MODE)
}

/** List provider ids that currently have a stored credential. */
export function listCredentialProviders(
  home: string,
  fsx: CredentialsFs = realCredentialsFs
): string[] {
  const current = readCredentials(home, fsx)
  return Object.keys(current.providers ?? {}).sort()
}

/** Store a search-provider API key (and optional Google CX) in credentials.json. */
export function setSearchCredential(
  home: string,
  providerId: CliSearchProviderId,
  apiKey: string,
  fsx: CredentialsFs = realCredentialsFs,
  options: { cx?: string } = {}
): string {
  if (!(CLI_SEARCH_PROVIDER_IDS as readonly string[]).includes(providerId)) {
    throw new Error(`unsupported search provider: ${providerId}`)
  }
  if (!apiKey.trim()) throw new Error("apiKey must not be empty")
  const current = readCredentials(home, fsx)
  const existing = current.searchProviders?.[providerId] ?? {}
  const next: CredentialsFile = {
    ...current,
    searchProviders: {
      ...(current.searchProviders ?? {}),
      [providerId]: {
        ...existing,
        apiKey,
        ...(options.cx?.trim() ? { cx: options.cx.trim() } : {}),
      },
    },
  }
  const target = credentialsPath(home)
  fsx.mkdirp(fsx.dirname(target))
  fsx.write(target, JSON.stringify(next, null, 2) + "\n", CREDENTIALS_MODE)
  return target
}

/** Remove one search-provider credential without touching model credentials. */
export function deleteSearchCredential(
  home: string,
  providerId: CliSearchProviderId,
  fsx: CredentialsFs = realCredentialsFs
): void {
  const current = readCredentials(home, fsx)
  if (!current.searchProviders?.[providerId]) return
  const searchProviders = { ...current.searchProviders }
  delete searchProviders[providerId]
  const target = credentialsPath(home)
  fsx.mkdirp(fsx.dirname(target))
  fsx.write(
    target,
    JSON.stringify({ ...current, searchProviders }, null, 2) + "\n",
    CREDENTIALS_MODE
  )
}

/** List search-provider ids that currently have stored credentials. */
export function listSearchCredentialProviders(
  home: string,
  fsx: CredentialsFs = realCredentialsFs
): string[] {
  const current = readCredentials(home, fsx)
  return Object.keys(current.searchProviders ?? {}).sort()
}

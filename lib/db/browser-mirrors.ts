/**
 * Metadata-only mirrors of two Rust-owned stores (schema v232, ADR-0201).
 *
 * The extension registry (`<app_data>/browser/extensions/registry.json`) and
 * the password vault (`cognia-secrets`) live in Rust. The renderer keeps a copy
 * of their *metadata* so the browser settings and the pane can show "3
 * extensions, 12 saved sign-ins" on first paint instead of waiting on IPC, and
 * so a web / mobile shell that cannot reach Rust still shows the last known
 * state as such.
 *
 * Neither table is ever the place a decision is made: Rust re-validates every
 * install, fill, reveal and export. Each write REPLACES the table with the
 * list Rust just returned, so a removed entry cannot linger.
 *
 * The credential mirror must never carry a secret. {@link toCredentialMetaRow}
 * builds the row from an explicit allow-list of fields, so even a caller that
 * hands it an object with a `password` property cannot persist one.
 */

import { getDb } from "./schema"

export interface BrowserExtensionMirrorRow {
  id: string
  name: string
  version: string
  enabled: boolean
  source: "webstore" | "crx" | "unpacked"
  installedAt: number
  permissions: string[]
  hostPermissions: string[]
  description?: string
  updateAvailable?: string
  /** When this copy was taken from Rust. */
  updatedAt: number
}

export interface BrowserCredentialMetaRow {
  id: string
  origin: string
  realm?: string
  username: string
  source: string
  createdAt: number
  sourceUpdatedAt: number
  lastUsedAt?: number
  note?: string
  /** When this copy was taken from Rust. */
  updatedAt: number
}

/** The subset of Rust's `BrowserExtension` the mirror keeps. */
export interface BrowserExtensionMirrorInput {
  id: string
  name: string
  version: string
  enabled: boolean
  source: "webstore" | "crx" | "unpacked"
  installedAt: number
  permissions: string[]
  hostPermissions: string[]
  description?: string | null
  updateAvailable?: string | null
}

/** The subset of Rust's `CredentialMeta` the mirror keeps. */
export interface BrowserCredentialMetaInput {
  id: string
  origin: string
  realm?: string | null
  username: string
  source: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number | null
  note?: string | null
}

export function toExtensionMirrorRow(
  input: BrowserExtensionMirrorInput,
  now: number
): BrowserExtensionMirrorRow {
  return {
    id: input.id,
    name: input.name,
    version: input.version,
    enabled: input.enabled,
    source: input.source,
    installedAt: input.installedAt,
    permissions: [...input.permissions],
    hostPermissions: [...input.hostPermissions],
    ...(input.description ? { description: input.description } : {}),
    ...(input.updateAvailable ? { updateAvailable: input.updateAvailable } : {}),
    updatedAt: now,
  }
}

export function toCredentialMetaRow(
  input: BrowserCredentialMetaInput,
  now: number
): BrowserCredentialMetaRow {
  return {
    id: input.id,
    origin: input.origin,
    ...(input.realm ? { realm: input.realm } : {}),
    username: input.username,
    source: input.source,
    createdAt: input.createdAt,
    sourceUpdatedAt: input.updatedAt,
    ...(typeof input.lastUsedAt === "number" ? { lastUsedAt: input.lastUsedAt } : {}),
    ...(input.note ? { note: input.note } : {}),
    updatedAt: now,
  }
}

export async function replaceBrowserExtensionMirror(
  extensions: readonly BrowserExtensionMirrorInput[],
  now: number = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.browserExtensionMirror, async () => {
    await db.browserExtensionMirror.clear()
    await db.browserExtensionMirror.bulkPut(
      extensions.map((extension) => toExtensionMirrorRow(extension, now))
    )
  })
}

export async function listBrowserExtensionMirror(): Promise<BrowserExtensionMirrorRow[]> {
  return getDb().browserExtensionMirror.orderBy("name").toArray()
}

export async function replaceBrowserCredentialMeta(
  credentials: readonly BrowserCredentialMetaInput[],
  now: number = Date.now()
): Promise<void> {
  const db = getDb()
  await db.transaction("rw", db.browserCredentialMeta, async () => {
    await db.browserCredentialMeta.clear()
    await db.browserCredentialMeta.bulkPut(
      credentials.map((credential) => toCredentialMetaRow(credential, now))
    )
  })
}

export async function listBrowserCredentialMeta(): Promise<BrowserCredentialMetaRow[]> {
  return getDb().browserCredentialMeta.orderBy("origin").toArray()
}

// Tracks which project working directories the user has explicitly trusted.
// Trust is required before we load `<cwd>/.claude/settings.json` hooks or
// custom shell commands — a malicious checkout could otherwise ship hooks
// that exfiltrate data the moment the user opens the project.
//
// Pattern mirrors VS Code's workspace trust: a single dialog on first sight,
// remembered per absolute path, revocable from settings.

import { isValidImageDigest } from "@/lib/project-environment/image-reference"
import type { WorkspaceRepositoryConfigV1 } from "@/lib/project-environment/workspace-config"

import { getDb } from "./schema"
import type {
  ApprovedEnvironmentDeclaration,
  TrustedWorkspace,
} from "@cognia/plugin-contract/lib/db/trusted-workspaces"
export type {
  ApprovedEnvironmentDeclaration,
  TrustedWorkspace,
} from "@cognia/plugin-contract/lib/db/trusted-workspaces"

/** The full trust row for a path, or undefined when it was never trusted. */
export async function getTrustedWorkspace(path: string): Promise<TrustedWorkspace | undefined> {
  if (!path) return undefined
  return getDb().trustedWorkspaces.get(normalize(path))
}

/**
 * Record the user's approval of the repository configuration currently at this
 * root. No-op for a root that is not trusted: approving a configuration inside
 * an untrusted checkout would create a grant the trust gate never sanctioned.
 */
export async function approveWorkspaceConfig(
  path: string,
  digest: string,
  config?: WorkspaceRepositoryConfigV1
): Promise<boolean> {
  if (!path || !digest) return false
  const key = normalize(path)
  const row = await getDb().trustedWorkspaces.get(key)
  if (!row) return false
  // Without the content, drop any older copy rather than keep one that no
  // longer matches the digest beside it: a stale "previous version" would
  // show a change against something the user never approved.
  const { approvedConfig: _stale, ...rest } = row
  await getDb().trustedWorkspaces.put({
    ...rest,
    approvedConfigDigest: digest,
    approvedConfigAt: Date.now(),
    ...(config ? { approvedConfig: config } : {}),
  })
  return true
}

/** The configuration approved for this root, when it was recorded with its content. */
export async function getApprovedWorkspaceConfig(
  path: string
): Promise<WorkspaceRepositoryConfigV1 | undefined> {
  if (!path) return undefined
  return (await getDb().trustedWorkspaces.get(normalize(path)))?.approvedConfig
}

/**
 * Record the user's approval of a runtime-environment declaration at this root.
 *
 * No-op for an untrusted root, for the same reason as `approveWorkspaceConfig`,
 * and for an approval that does not pin its image to a digest: storing a tag
 * would approve whatever the registry serves under it later.
 */
export async function approveEnvironmentDeclaration(
  path: string,
  approval: Omit<ApprovedEnvironmentDeclaration, "approvedAt">
): Promise<boolean> {
  if (!path || !/^[0-9a-f]{64}$/.test(approval.declarationDigest)) return false
  if (!approval.path || !isValidImageDigest(approval.resolvedImage.digest)) return false
  const key = normalize(path)
  const row = await getDb().trustedWorkspaces.get(key)
  if (!row) return false
  await getDb().trustedWorkspaces.put({
    ...row,
    approvedEnvironment: {
      declarationDigest: approval.declarationDigest,
      file: approval.file,
      path: approval.path,
      resolvedImage: {
        registry: approval.resolvedImage.registry,
        repository: approval.resolvedImage.repository,
        digest: approval.resolvedImage.digest,
      },
      approvedAt: Date.now(),
    },
  })
  return true
}

/**
 * Withdraw the runtime-environment approval at this root, keeping folder trust
 * and the workspace.json approval. Returns whether an approval was removed.
 */
export async function revokeEnvironmentApproval(path: string): Promise<boolean> {
  if (!path) return false
  const key = normalize(path)
  const row = await getDb().trustedWorkspaces.get(key)
  if (!row?.approvedEnvironment) return false
  const { approvedEnvironment: _removed, ...rest } = row
  await getDb().trustedWorkspaces.put(rest)
  return true
}

/**
 * Record an approval together with the declarations it seeded.
 *
 * One write, because they are one decision: persisting the seed record without
 * what it seeded loses the suggestion permanently, and the reverse re-offers it
 * on every pull.
 */
export async function recordSeededDeclarations(
  path: string,
  seeded: readonly string[]
): Promise<boolean> {
  if (!path) return false
  const key = normalize(path)
  const row = await getDb().trustedWorkspaces.get(key)
  if (!row) return false
  await getDb().trustedWorkspaces.put({ ...row, seededDeclarations: [...seeded] })
  return true
}

/** Whether the given absolute path has been previously trusted. */
export async function isWorkspaceTrusted(path: string): Promise<boolean> {
  if (!path) return false
  const row = await getDb().trustedWorkspaces.get(normalize(path))
  return !!row
}

/** Record the user's "Trust this workspace" decision. */
export async function trustWorkspace(path: string, note?: string): Promise<void> {
  if (!path) return
  const row: TrustedWorkspace = {
    path: normalize(path),
    trustedAt: Date.now(),
    note,
  }
  await getDb().trustedWorkspaces.put(row)
  syncTrustGateToRust()
}

/** List all trusted workspaces (most recently trusted first). */
export async function listTrustedWorkspaces(): Promise<TrustedWorkspace[]> {
  return getDb().trustedWorkspaces.orderBy("trustedAt").reverse().toArray()
}

/** Revoke trust for a previously-trusted workspace. */
export async function revokeWorkspaceTrust(path: string): Promise<void> {
  if (!path) return
  await getDb().trustedWorkspaces.delete(normalize(path))
  syncTrustGateToRust()
}

/**
 * Re-push the trust ledger into the Rust hooks gate after a change. Fire-and-
 * forget via a dynamic import so this Dexie module stays decoupled from Tauri
 * (the sync helper is a no-op on web). Errors are swallowed inside the helper.
 */
function syncTrustGateToRust(): void {
  void import("@/lib/claude/hook-trust-sync")
    .then((m) => m.syncTrustedWorkspacesToRust())
    .catch(() => {})
}

/**
 * Normalise a path before comparison. We don't canonicalise (would require
 * sync filesystem access); we only collapse trailing separators and uniform
 * the forward/back slash style. Two paths that point at the same directory
 * but spell differently must be trusted independently — a small UX cost
 * that's worth the implementation simplicity.
 */
function normalize(path: string): string {
  let p = path.trim()
  while (p.endsWith("/") || p.endsWith("\\")) {
    p = p.slice(0, -1)
  }
  return p
}

/**
 * The gate in front of `.cognia/workspace.json`.
 *
 * # Why a repository file needs one at all
 *
 * The file ships `setup` and `actions` — shell scripts Cognia runs before a
 * turn — plus `variables` that become that process's environment, `cacheLinks`
 * that symlink directories into the working tree, and `include` that copies
 * gitignored files into a worktree. Reading it is therefore code execution
 * delivered by `git pull`, and every one of those fields is a way to reach the
 * user's machine.
 *
 * # Two decisions, not one
 *
 * Workspace Trust already answers "is this checkout mine" — granted once per
 * folder, revocable, and the same gate that guards `.claude/settings.json`
 * hooks. That is necessary here and it is NOT sufficient: it is granted before
 * the repository's later commits exist. A contributor who trusted a folder in
 * March did not approve the setup script that landed in it in August.
 *
 * So the verdict has two layers:
 *
 *   1. **Untrusted → the file is not read.** Not "read but ignore the scripts":
 *      `roots` widens the agent's filesystem reach and `variables` reach the
 *      same process, so there is no half of this file that is safe to honour in
 *      a checkout the user has not vouched for.
 *   2. **Trusted → the CONTENT must have been approved.** The approved digest
 *      lives on the trust row. A first sight and a later change are the same
 *      state (`unapproved`) with different context, because they need the same
 *      answer from the user.
 *
 * # What the digest covers
 *
 * The whole normalized configuration, not a hand-picked "dangerous" subset.
 * Deciding which half of the file is safe is a judgement that will eventually
 * be wrong — `variables` alone can set `NODE_OPTIONS=--require ./evil.js`.
 * Digesting the PARSED form (not the file text) means reformatting, key
 * reordering and comment churn do not re-prompt, while any semantic change
 * does.
 *
 * # Failing closed
 *
 * Every non-approved verdict means the repository configuration is not applied
 * and the device-local environment runs alone. That degrades to exactly the
 * behaviour before this file was wired up, which is a safe floor — but a silent
 * one, so callers surface the verdict rather than swallowing it.
 */

import type { TrustedWorkspace } from "@/lib/db/trusted-workspaces"
import { sha256String } from "@/lib/ocr/hash"
import type { Project } from "@/types"

import type { DeclarationProblem } from "./environment-declaration"
import {
  AcceptanceProfilesConfigError,
  PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY,
  WorkspaceConfigError,
  jsonPointer,
  mergeAcceptanceProfiles,
  parseAcceptanceProfilesValue,
  readWorkspaceAcceptanceProfiles,
  readWorkspaceConfig,
  type AcceptanceProfileProblem,
  type AcceptanceProfileSource,
  type WorkspaceAcceptanceProfile,
  type WorkspaceAcceptanceProfiles,
  type WorkspaceRepositoryConfigV1,
} from "./workspace-config"

export type WorkspaceConfigVerdict =
  /** No `.cognia/workspace.json` at this root. */
  | { kind: "absent" }
  /** Present, but the workspace is not trusted — deliberately not read. */
  | { kind: "restricted" }
  /**
   * Present and unreadable. Reported, never silently skipped. `problems` lists
   * every issue when the `environment` block (ADR-0182) is what failed.
   */
  | { kind: "invalid"; message: string; field: string; problems?: DeclarationProblem[] }
  /**
   * Present, valid, and awaiting the user. `approvedDigest` is absent on first
   * sight and set when a previously approved configuration has changed — the
   * UI needs to tell those apart even though the gate does not.
   */
  | {
      kind: "unapproved"
      digest: string
      approvedDigest?: string
      config: WorkspaceRepositoryConfigV1
    }
  /** Present, valid, and approved at this exact content. */
  | { kind: "approved"; digest: string; config: WorkspaceRepositoryConfigV1 }

/** Whether this verdict means the configuration may be applied. */
export function isConfigApplied(
  verdict: WorkspaceConfigVerdict
): verdict is Extract<WorkspaceConfigVerdict, { kind: "approved" }> {
  return verdict.kind === "approved"
}

/**
 * Whether this verdict is something the user should be told about.
 *
 * `absent` is the overwhelmingly common case and says nothing. Everything else
 * means the repository asked for something that is not happening.
 */
export function verdictNeedsAttention(verdict: WorkspaceConfigVerdict): boolean {
  return (
    verdict.kind === "unapproved" || verdict.kind === "invalid" || verdict.kind === "restricted"
  )
}

/**
 * Canonical JSON: every object's keys in sorted order, arrays left in place.
 *
 * Array order is content — `actions` runs in order and `roots[0]` is not
 * interchangeable with `roots[1]` — so sorting them would make two different
 * configurations digest the same.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(row).sort()) out[key] = canonicalize(row[key])
    return out
  }
  return value
}

/** Stable digest of a parsed configuration. See the header. */
export async function workspaceConfigDigest(config: WorkspaceRepositoryConfigV1): Promise<string> {
  return sha256String(JSON.stringify(canonicalize(config)))
}

export interface EvaluateWorkspaceConfigInput {
  /**
   * Where the file is read from — the conversation's execution root, so the
   * configuration reflects the branch it is actually on.
   */
  configRoot: string | null | undefined
  /** The workspace, for the trust decision and the approval key. */
  project: Pick<Project, "roots"> | null | undefined
  /** `appSettings.workspaceTrust?.enabled !== false`. */
  trustEnabled: boolean
  /** True in the browser, where there is no real local filesystem. */
  onWeb: boolean
}

export interface EvaluateWorkspaceConfigDeps {
  readFile: (root: string, relPath: string, maxBytes: number) => Promise<string>
  isRestricted: (
    project: Pick<Project, "roots"> | null | undefined,
    opts: { enabled: boolean; onWeb: boolean }
  ) => Promise<boolean>
  approvedDigestFor: (path: string) => Promise<string | undefined>
}

/**
 * Every field lazy, so a caller that injects all of them (tests, the plugin
 * host) does not drag Dexie and the filesystem bridge in behind them.
 */
const DEFAULT_DEPS: EvaluateWorkspaceConfigDeps = {
  readFile: async (root, relPath, maxBytes) => {
    const { readWorkspaceFile } = await import("@/lib/files/workspace-fs")
    return readWorkspaceFile(root, relPath, maxBytes)
  },
  isRestricted: async (project, opts) => {
    const { isWorkspaceRestricted } = await import("@/lib/workspace/trust-gate")
    return isWorkspaceRestricted(project, opts)
  },
  approvedDigestFor: async (path) => {
    const { getTrustedWorkspace } = await import("@/lib/db/trusted-workspaces")
    return (await getTrustedWorkspace(path))?.approvedConfigDigest
  },
}

/**
 * The approval is keyed on the workspace's PRIMARY root, not on the directory
 * the file was read from. A managed worktree is a checkout of the same
 * repository at a different path; keying on it would ask the user to approve
 * the same configuration again for every worktree, and a worktree path is not
 * something they ever chose to trust.
 */
export function approvalKeyFor(project: Pick<Project, "roots"> | null | undefined): string | null {
  const roots = project?.roots ?? []
  const primary = roots.find((root) => root.isPrimary) ?? roots[0]
  return primary?.path?.trim() || null
}

export async function evaluateWorkspaceConfig(
  input: EvaluateWorkspaceConfigInput,
  deps?: Partial<EvaluateWorkspaceConfigDeps>
): Promise<WorkspaceConfigVerdict> {
  const root = input.configRoot?.trim()
  if (!root) return { kind: "absent" }

  const resolved: EvaluateWorkspaceConfigDeps = { ...DEFAULT_DEPS, ...deps }

  // Trust first, and before the read: an untrusted checkout's file is not
  // parsed, not digested, and not reported field-by-field.
  const restricted = await resolved
    .isRestricted(input.project, { enabled: input.trustEnabled, onWeb: input.onWeb })
    .catch(() => true)
  if (restricted) {
    // Only worth saying when there is something to say. Probing for the file's
    // existence is safe — it reads nothing out of it.
    const present = await fileExists(resolved, root)
    return present ? { kind: "restricted" } : { kind: "absent" }
  }

  let config: WorkspaceRepositoryConfigV1 | null
  try {
    config = await readWorkspaceConfig(root, resolved.readFile)
  } catch (cause) {
    if (cause instanceof WorkspaceConfigError) {
      return {
        kind: "invalid",
        message: cause.message,
        field: cause.field,
        ...(cause.problems.length > 0 ? { problems: cause.problems } : {}),
      }
    }
    return {
      kind: "invalid",
      message: cause instanceof Error ? cause.message : String(cause),
      field: "workspace.json",
    }
  }
  if (!config) return { kind: "absent" }

  const digest = await workspaceConfigDigest(config)
  const key = approvalKeyFor(input.project)
  const approvedDigest = key
    ? await resolved.approvedDigestFor(key).catch(() => undefined)
    : undefined
  if (approvedDigest && approvedDigest === digest) return { kind: "approved", digest, config }
  return {
    kind: "unapproved",
    digest,
    config,
    ...(approvedDigest ? { approvedDigest } : {}),
  }
}

async function fileExists(deps: EvaluateWorkspaceConfigDeps, root: string): Promise<boolean> {
  try {
    const { WORKSPACE_CONFIG_PATH, WORKSPACE_CONFIG_MAX_BYTES } = await import("./workspace-config")
    await deps.readFile(root, WORKSPACE_CONFIG_PATH, WORKSPACE_CONFIG_MAX_BYTES)
    return true
  } catch {
    return false
  }
}

// ── Acceptance profiles (ADR-0188 D15) ─────────────────────────────────────
//
// The third thing a repository file can ask to run, after its configuration
// (ADR-0147) and its runtime environment (ADR-0182): the command that proves
// a Router + Fusion delegate patch. It gets the same two layers, narrowed to
// what executes:
//
//   1. Untrusted → nothing is read, the project's own profiles included: the
//      command runs the checkout's code.
//   2. Trusted → each profile runs only once approved AT ITS COMMAND HASH, for
//      this project. First sight and a changed command are both "not
//      approved"; the status says which, because the UI words them apart.
//
// A separate grant, not part of the configuration digest: approving setup
// scripts does not approve a test command, and a changed test command does
// not re-open the setup-script approval. Nothing here runs unless Router +
// Fusion calls it (`lib/router-fusion/verify/acceptance-profiles.ts`).

/**
 * `commandHash`: SHA-256 over the canonical JSON of what executes and what is
 * read back, `{ command, cwd, report }`. Canonical as `canonicalize` above
 * (object keys sorted, arrays in order: argv order is the command) and over the PARSED
 * profile, so formatting and key order never re-prompt and an omitted `cwd`
 * hashes as `"."`. `requiredTests` and `timeoutMs` are outside it: they change
 * what counts as passing and how long it may take, not what runs.
 *
 * Byte-for-byte the value `canonicalHash({ command, cwd, report })` from
 * `@cognia/router-fusion` gives, so package code can recompute it
 * synchronously (pinned by `lib/router-fusion/verify/acceptance-profiles.test.ts`).
 */
export async function acceptanceProfileCommandHash(
  profile: Pick<WorkspaceAcceptanceProfile, "command" | "cwd" | "report">
): Promise<string> {
  return sha256String(
    JSON.stringify(
      canonicalize({
        command: profile.command,
        cwd: profile.cwd,
        report: { format: profile.report.format, path: profile.report.path },
      })
    )
  )
}

/**
 * One acceptance-profile approval.
 *
 * Stored on the workspace's trust row (`TrustedWorkspace`, keyed by the primary
 * root like every other approval on it) as `approvedAcceptanceProfiles`:
 * non-indexed and optional, so no Dexie version bump, and revoking folder
 * trust deletes the row and every approval with it, which is right, since an
 * untrusted workspace has none. One record per (project, profile), replaced by
 * the next approval; a current hash that differs from it is `changed`, never
 * `approved`.
 */
export interface AcceptanceProfileApprovalRecord {
  projectId: string
  profileId: string
  /** `acceptanceProfileCommandHash` of the profile as approved. */
  commandHash: string
  /** Wall-clock millis of the approval. */
  approvedAt: number
}

/** The trust row with the one field this module owns. */
export type TrustedWorkspaceWithAcceptanceApprovals = TrustedWorkspace & {
  approvedAcceptanceProfiles?: AcceptanceProfileApprovalRecord[]
}

const COMMAND_HASH = /^[0-9a-f]{64}$/

function isApprovalRecord(value: unknown): value is AcceptanceProfileApprovalRecord {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return (
    typeof row.projectId === "string" &&
    row.projectId !== "" &&
    typeof row.profileId === "string" &&
    row.profileId !== "" &&
    typeof row.commandHash === "string" &&
    COMMAND_HASH.test(row.commandHash) &&
    typeof row.approvedAt === "number"
  )
}

/** Rows come off Dexie unvalidated: a malformed entry approves nothing. */
function approvalRecordsOf(
  row: TrustedWorkspaceWithAcceptanceApprovals | undefined
): AcceptanceProfileApprovalRecord[] {
  const records = row?.approvedAcceptanceProfiles
  return Array.isArray(records) ? records.filter(isApprovalRecord) : []
}

/** Lazy, so nothing above drags Dexie in for a caller that injects its deps. */
async function trustRows() {
  const [{ getDb }, { getTrustedWorkspace }] = await Promise.all([
    import("@/lib/db/schema"),
    import("@/lib/db/trusted-workspaces"),
  ])
  return { db: getDb(), getTrustedWorkspace }
}

/** Every acceptance-profile approval recorded against this root, every project. */
export async function listAcceptanceProfileApprovals(
  path: string
): Promise<AcceptanceProfileApprovalRecord[]> {
  if (!path) return []
  const { getTrustedWorkspace } = await import("@/lib/db/trusted-workspaces")
  return approvalRecordsOf(await getTrustedWorkspace(path))
}

/**
 * Record the approval of one profile at one command hash, replacing the
 * project's previous approval of that profile. Returns null, writing nothing,
 * for a root that is not trusted (the grant would be one the trust gate never
 * sanctioned, exactly as `approveWorkspaceConfig`) and for a malformed hash.
 * Callers bind the hash to what the user saw: see `approveAcceptanceProfile`.
 */
export async function recordAcceptanceProfileApproval(
  path: string,
  approval: Omit<AcceptanceProfileApprovalRecord, "approvedAt">,
  now = Date.now()
): Promise<AcceptanceProfileApprovalRecord | null> {
  if (!path || !approval.projectId || !approval.profileId) return null
  if (!COMMAND_HASH.test(approval.commandHash)) return null
  const { db, getTrustedWorkspace } = await trustRows()
  return db.transaction("rw", db.trustedWorkspaces, async () => {
    const row = (await getTrustedWorkspace(path)) as
      TrustedWorkspaceWithAcceptanceApprovals | undefined
    if (!row) return null
    const record: AcceptanceProfileApprovalRecord = {
      projectId: approval.projectId,
      profileId: approval.profileId,
      commandHash: approval.commandHash,
      approvedAt: now,
    }
    const next: TrustedWorkspaceWithAcceptanceApprovals = {
      ...row,
      approvedAcceptanceProfiles: [
        ...approvalRecordsOf(row).filter(
          (entry) =>
            !(entry.projectId === approval.projectId && entry.profileId === approval.profileId)
        ),
        record,
      ],
    }
    await db.trustedWorkspaces.put(next)
    return record
  })
}

/**
 * Withdraw one project's approval of one profile, keeping folder trust and
 * every other approval on the row. Returns whether an approval was removed.
 */
export async function removeAcceptanceProfileApproval(
  path: string,
  key: Pick<AcceptanceProfileApprovalRecord, "projectId" | "profileId">
): Promise<boolean> {
  if (!path || !key.projectId || !key.profileId) return false
  const { db, getTrustedWorkspace } = await trustRows()
  return db.transaction("rw", db.trustedWorkspaces, async () => {
    const row = (await getTrustedWorkspace(path)) as
      TrustedWorkspaceWithAcceptanceApprovals | undefined
    if (!row) return false
    const records = approvalRecordsOf(row)
    const kept = records.filter(
      (entry) => !(entry.projectId === key.projectId && entry.profileId === key.profileId)
    )
    if (kept.length === records.length) return false
    const { approvedAcceptanceProfiles: _removed, ...rest } = row
    const next: TrustedWorkspaceWithAcceptanceApprovals =
      kept.length > 0 ? { ...rest, approvedAcceptanceProfiles: kept } : rest
    await db.trustedWorkspaces.put(next)
    return true
  })
}

export type AcceptanceProfileStatus =
  /** Approved at exactly this command hash, for this project. The only status that may run. */
  | "approved"
  /** Never approved for this project: first sight. */
  | "unapproved"
  /** Approved before at a different command hash: the command changed since. */
  | "changed"

export interface AcceptanceProfileState {
  id: string
  profile: WorkspaceAcceptanceProfile
  source: AcceptanceProfileSource
  commandHash: string
  status: AcceptanceProfileStatus
  /** The hash that was approved, when `changed`. */
  approvedCommandHash?: string
  /** When this hash was approved, when `approved`. */
  approvedAt?: number
}

export type AcceptanceProfilesVerdict =
  /** No root to read from, or neither the file nor the project declares a profile. */
  | { kind: "absent" }
  /** Profiles may exist, but the workspace is not trusted: nothing was read. */
  | { kind: "restricted" }
  /**
   * The file (any part of it: a broken file never half-applies) or the project
   * override is invalid. `problems` carries every acceptance-profile problem,
   * each with its JSON pointer, when that is what failed.
   */
  | { kind: "invalid"; message: string; field: string; problems?: AcceptanceProfileProblem[] }
  | {
      kind: "declared"
      /** Where approvals are recorded (the primary root); null for a project without roots. */
      approvalKey: string | null
      /** Every effective profile, sorted by id, with its approval status. */
      profiles: AcceptanceProfileState[]
      /** Repository profiles the project override replaces. */
      overriddenProfiles: string[]
    }

export interface EvaluateAcceptanceProfilesInput {
  /** Where `.cognia/workspace.json` is read from (the primary root, or a run's execution root). */
  configRoot: string | null | undefined
  /** The workspace, for the trust decision and the approval key. */
  project: Pick<Project, "roots"> | null | undefined
  /** The project approvals are recorded for. */
  projectId: string
  /** The project override, raw: `Project.metadata[PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY]`. */
  projectProfiles?: unknown
  /** `appSettings.workspaceTrust?.enabled !== false`. */
  trustEnabled: boolean
  /** True in the browser, where there is no real local filesystem. */
  onWeb: boolean
}

export interface EvaluateAcceptanceProfilesDeps extends Pick<
  EvaluateWorkspaceConfigDeps,
  "readFile" | "isRestricted"
> {
  approvalsFor: (path: string) => Promise<AcceptanceProfileApprovalRecord[]>
}

const DEFAULT_ACCEPTANCE_DEPS: EvaluateAcceptanceProfilesDeps = {
  readFile: DEFAULT_DEPS.readFile,
  isRestricted: DEFAULT_DEPS.isRestricted,
  approvalsFor: listAcceptanceProfileApprovals,
}

function acceptanceInvalid(cause: unknown): AcceptanceProfilesVerdict {
  if (cause instanceof AcceptanceProfilesConfigError) {
    return {
      kind: "invalid",
      message: cause.message,
      field: cause.field,
      problems: cause.acceptanceProblems,
    }
  }
  if (cause instanceof WorkspaceConfigError) {
    return { kind: "invalid", message: cause.message, field: cause.field }
  }
  return {
    kind: "invalid",
    message: cause instanceof Error ? cause.message : String(cause),
    field: "workspace.json",
  }
}

/**
 * The acceptance profiles a project may run, each with its approval status.
 * The loader behind every Router + Fusion question about them; see the section
 * header for the two layers.
 */
export async function evaluateAcceptanceProfiles(
  input: EvaluateAcceptanceProfilesInput,
  deps?: Partial<EvaluateAcceptanceProfilesDeps>
): Promise<AcceptanceProfilesVerdict> {
  const root = input.configRoot?.trim()
  if (!root) return { kind: "absent" }

  const resolved: EvaluateAcceptanceProfilesDeps = { ...DEFAULT_ACCEPTANCE_DEPS, ...deps }

  // Trust first, before any read, exactly as `evaluateWorkspaceConfig`.
  const restricted = await resolved
    .isRestricted(input.project, { enabled: input.trustEnabled, onWeb: input.onWeb })
    .catch(() => true)
  if (restricted) {
    const present =
      input.projectProfiles !== undefined ||
      (await fileExists({ ...DEFAULT_DEPS, readFile: resolved.readFile }, root))
    return present ? { kind: "restricted" } : { kind: "absent" }
  }

  let repository: WorkspaceAcceptanceProfiles | null
  try {
    repository = await readWorkspaceAcceptanceProfiles(root, resolved.readFile)
  } catch (cause) {
    return acceptanceInvalid(cause)
  }
  const project = parseAcceptanceProfilesValue(
    input.projectProfiles,
    jsonPointer("/metadata", PROJECT_ACCEPTANCE_PROFILES_METADATA_KEY)
  )
  if (!project.ok) {
    return acceptanceInvalid(new AcceptanceProfilesConfigError(project.problems))
  }

  const merged = mergeAcceptanceProfiles(repository ?? {}, project.profiles)
  if (merged.profiles.length === 0) return { kind: "absent" }

  const approvalKey = approvalKeyFor(input.project)
  const records = approvalKey
    ? (await resolved.approvalsFor(approvalKey).catch(() => []))
        .filter(isApprovalRecord)
        .filter((record) => record.projectId === input.projectId)
    : []
  const profiles = await Promise.all(
    merged.profiles.map(async ({ id, profile, source }): Promise<AcceptanceProfileState> => {
      const commandHash = await acceptanceProfileCommandHash(profile)
      const record = records.find((entry) => entry.profileId === id)
      if (record?.commandHash === commandHash) {
        return {
          id,
          profile,
          source,
          commandHash,
          status: "approved",
          approvedAt: record.approvedAt,
        }
      }
      if (record) {
        return {
          id,
          profile,
          source,
          commandHash,
          status: "changed",
          approvedCommandHash: record.commandHash,
        }
      }
      return { id, profile, source, commandHash, status: "unapproved" }
    })
  )
  return { kind: "declared", approvalKey, profiles, overriddenProfiles: merged.overriddenProfiles }
}

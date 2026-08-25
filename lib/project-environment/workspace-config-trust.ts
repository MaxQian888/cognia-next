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

import { sha256String } from "@/lib/ocr/hash"
import type { Project } from "@/types"

import {
  WorkspaceConfigError,
  readWorkspaceConfig,
  type WorkspaceRepositoryConfigV1,
} from "./workspace-config"

export type WorkspaceConfigVerdict =
  /** No `.cognia/workspace.json` at this root. */
  | { kind: "absent" }
  /** Present, but the workspace is not trusted — deliberately not read. */
  | { kind: "restricted" }
  /** Present and unreadable. Reported, never silently skipped. */
  | { kind: "invalid"; message: string; field: string }
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
      return { kind: "invalid", message: cause.message, field: cause.field }
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

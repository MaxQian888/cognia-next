/**
 * External Bridge — workspace, git and shell tools (roadmap 2026-09-29,
 * Phase 2; ADR-0203).
 *
 * Local MCP clients (Claude Desktop, Cursor, Codex, …) get bounded dev-machine
 * primitives over the loopback bridge. Nothing here is a new execution layer:
 * every tool is a thin projection of a host surface the app already uses —
 *
 *  - files: `lib/files/workspace-fs` (`fs_*_workspace`, root-confined,
 *    symlink-final-refusing writes);
 *  - git: `lib/git/commands` and `readWorkspaceDiff` (read-only);
 *  - commands: the `cognia-jobs` supervisor through `lib/jobs/background-jobs`
 *    (own process group, tree-kill), fronted by `classifyCommand`.
 *
 * What this module adds is the fence those surfaces do not have for a remote
 * caller:
 *
 *  - roots are addressed by `WorkspaceRoot.id` and must be granted to the
 *    calling client (`./workspace/grants`) — the host would accept any
 *    absolute root from the renderer;
 *  - the two-tier path policy (`../workspace/path-policy`): credential paths
 *    and `.git` internals are refused on every tool, bulk trees are skipped in
 *    scans;
 *  - consent: `classifyCommand` `deny` refuses, `ask` (or a command naming a
 *    credential path) asks the user in-app on EVERY call; so does a delete;
 *  - outbound: file content, diffs, commit text and command output are
 *    PII-redacted and then must pass `hasNoLeakingPiiDeep`, like every other
 *    bridge result; a write carrying a redaction placeholder is refused so a
 *    redacted read can never be written back over the real text;
 *  - the Phase 1 result vocabulary (`../tool-result`): long work answers
 *    `pending` with its continuation, failures are decision-complete, clamped
 *    inputs are reported, and job exits piggyback as `attention`.
 *
 * Wire path mirrors `browser.ts`: the renderer runs the core directly; the
 * Node MCP sidecar forwards `workspace_tool` over the orchestration proxy.
 */

import { isTauri } from "@/lib/tauri"
import { proxyToRenderer } from "@/lib/external-bridge/orchestration-proxy-client"
import type { CommandClassification } from "@/lib/claude/permissions/command-safety"
import type { BackgroundJobOutput, BackgroundJobRecord } from "@/lib/jobs/background-jobs"
import type { WorkspaceContentMatch, WorkspaceEntry, WorkspaceStat } from "@/lib/files/types"
import type { GitCommit, GitDiff, GitFileChange, GitStatus } from "@/types/git"
import {
  adjustedField,
  clampInput,
  pendingMarker,
  toolFailure,
  type Adjustments,
  type ToolFailure,
} from "../tool-result"
import { jobAttention, type AttentionDelivery, type JobAttention } from "../workspace/attention"
import {
  resolveGrantedRoots,
  resolveTarget,
  normalizeRelPath,
  type GrantDeps,
  type GrantedRoot,
} from "../workspace/grants"
import {
  classifyWorkspacePath,
  commandTouchesSecretPath,
  isSecretWorkspacePath,
} from "../workspace/path-policy"
import { isWorkspaceToolName, type WorkspaceToolName } from "../workspace/tool-names"

export interface WorkspaceToolInput {
  tool: string
  args?: Record<string, unknown>
  /** The MCP client identity (`mcp:<client>` or `mcp:stdio`). */
  clientId: string
}

/** Fields every result may carry besides its own payload. */
interface ResultExtras {
  /** True iff a string in the result was PII-redacted on the way out. */
  redacted?: boolean
  /** Job exits for this client since its last result (piggyback). */
  attention?: AttentionDelivery
}

export type WorkspaceToolOutput =
  ({ ok: true } & Record<string, unknown> & ResultExtras) | (ToolFailure & ResultExtras)

export async function workspaceTool(input: WorkspaceToolInput): Promise<WorkspaceToolOutput> {
  if (isTauri()) return workspaceToolCore(input)
  return proxyToRenderer<WorkspaceToolOutput>("workspace_tool", { ...input })
}

// ---------------------------------------------------------------------------
// Renderer side
// ---------------------------------------------------------------------------

/** Consent identity for a delete or a risky command. Never remembered. */
export const WORKSPACE_BRIDGE_PER_CALL_CONSENT_ID = "cognia-external-bridge:workspace:per-call"

/** A file larger than this is not edited in place (`workspace_edit`). */
export const EDIT_MAX_BYTES = 2 * 1024 * 1024

export interface WorkspaceBridgeDeps {
  grants?: GrantDeps
  fs: {
    walk(
      root: string,
      options: { relPath?: string; includeDirs?: boolean; maxEntries?: number; maxDepth?: number }
    ): Promise<{ entries: WorkspaceEntry[]; truncated: boolean; skippedSensitive: number }>
    stat(root: string, relPath: string): Promise<WorkspaceStat>
    read(root: string, relPath: string, maxBytes?: number): Promise<string>
    searchContent(
      root: string,
      query: string,
      options: { isRegex?: boolean; caseSensitive?: boolean; maxResults?: number }
    ): Promise<WorkspaceContentMatch[]>
    searchNames(root: string, query: string, limit: number): Promise<WorkspaceEntry[]>
    write(root: string, relPath: string, content: string): Promise<void>
    rename(root: string, from: string, to: string): Promise<void>
    remove(root: string, relPath: string, recursive?: boolean): Promise<void>
  }
  git: {
    isRepo(repoPath: string): Promise<boolean>
    status(repoPath: string): Promise<GitStatus>
    diffFile(repoPath: string, path: string, staged: boolean): Promise<GitDiff>
    workspaceDiff(
      repoPath: string,
      options: { maxChars: number; status: (repoPath: string) => Promise<GitStatus> }
    ): Promise<{ text: string; fileCount: number; truncated: boolean }>
    log(repoPath: string, maxCount: number, skip: number): Promise<GitCommit[]>
    fileHistory(repoPath: string, path: string, maxCount: number): Promise<GitCommit[]>
    commitFiles(repoPath: string, sha: string): Promise<GitFileChange[]>
    diffCommit(repoPath: string, sha: string, path: string): Promise<GitDiff>
  }
  jobs: {
    spawn(input: {
      clientId: string
      command: string
      cwd: string
      label?: string
    }): Promise<BackgroundJobRecord>
    wait(
      jobId: string,
      fromOffset: number,
      options: { maxBytes: number; waitMs: number }
    ): Promise<BackgroundJobOutput>
    list(clientId: string): Promise<BackgroundJobRecord[]>
    kill(jobId: string): Promise<BackgroundJobRecord>
  }
  classify(command: string, cwd: string): CommandClassification
  requestConsent(request: { consentId: string; reason: string }): Promise<boolean>
  translate(key: string, values?: Record<string, unknown>): Promise<string>
  redact(text: string): { text: string; redacted: boolean }
  /** Whether a text carries a redaction placeholder (`<EMAIL_001>` …). */
  hasPlaceholder(text: string): boolean
  /** The outbound PII gate, run on the ALREADY-redacted result. */
  piiFree(value: unknown): boolean | Promise<boolean>
  attention: JobAttention
  now(): number
  /**
   * Whether this renderer can serve the family. The job commands are
   * desktop-local (`client` target): a headless host's transport refuses them,
   * and with a remote host active the fs/git/job calls would be split between
   * two machines. Both answer `desktop_only` instead.
   */
  hostSupported(): boolean
}

let depsOverride: WorkspaceBridgeDeps | null = null

/** Test seam: inject deps (pass `null` to restore the real ones). */
export function __setWorkspaceBridgeDepsForTests(deps: WorkspaceBridgeDeps | null): void {
  depsOverride = deps
}

async function defaultDeps(): Promise<WorkspaceBridgeDeps> {
  const [fs, search, git, diff, jobs, safety, consent, i18n, redact, platform, routing] =
    await Promise.all([
      import("@/lib/files/workspace-fs"),
      import("@/lib/files/workspace-search"),
      import("@/lib/git/commands"),
      import("@/lib/git/workspace-diff"),
      import("@/lib/jobs/background-jobs"),
      import("@/lib/claude/permissions/command-safety"),
      import("@/lib/plugin/security/consent-broker"),
      import("@/lib/i18n/runtime-translator"),
      import("@cognia/redact"),
      import("@/lib/platform/detect"),
      import("@/lib/tauri/transport-routing"),
    ])
  const placeholder = new RegExp(redact.PII_PLACEHOLDER_SOURCE)
  return {
    fs: {
      walk: fs.walkWorkspace,
      stat: fs.statWorkspaceFile,
      read: fs.readWorkspaceFile,
      searchContent: fs.searchWorkspaceContent,
      searchNames: search.searchWorkspace,
      write: fs.writeWorkspaceFile,
      rename: fs.renameWorkspaceEntry,
      remove: fs.deleteWorkspaceEntry,
    },
    git: {
      isRepo: git.gitIsRepo,
      status: git.gitStatus,
      diffFile: git.gitDiffFile,
      workspaceDiff: (repoPath, options) =>
        diff.readWorkspaceDiff(repoPath, {
          maxChars: options.maxChars,
          deps: { isRepo: git.gitIsRepo, status: options.status, diffFile: git.gitDiffFile },
        }),
      log: git.gitLog,
      fileHistory: git.gitFileHistory,
      commitFiles: git.gitCommitFiles,
      diffCommit: git.gitDiffCommit,
    },
    jobs: {
      spawn: jobs.spawnBridgeBackgroundJob,
      wait: (jobId, fromOffset, options) =>
        jobs.waitBackgroundJobOutput(jobId, fromOffset, options),
      list: (clientId) => jobs.listBackgroundJobs(jobs.bridgeJobOwner(clientId)),
      kill: jobs.killBackgroundJob,
    },
    classify: (command, cwd) => safety.classifyCommand(command, { cwd }),
    requestConsent: async ({ consentId, reason }) => {
      const broker = consent.getPluginConsentBroker()
      // Per-call: an "Always allow this session" answer must never cover the
      // next delete or risky command.
      broker.clearSessionGrantsForPlugin(consentId)
      try {
        return await broker.request({ pluginId: consentId, permission: "agent:control", reason })
      } finally {
        broker.clearSessionGrantsForPlugin(consentId)
      }
    },
    translate: async (key, values) =>
      (await i18n.getRuntimeTranslator("settings.externalBridge"))(key, values),
    redact: (text) => {
      const { redacted, map } = redact.redactText(text)
      return { text: redacted, redacted: Object.keys(map).length > 0 }
    },
    hasPlaceholder: (text) => placeholder.test(text),
    piiFree: (value) => redact.hasNoLeakingPiiDeep(value),
    attention: jobAttention(),
    now: () => Date.now(),
    hostSupported: () => !platform.isHeadlessHost() && !routing.isRemoteHostActive(),
  }
}

// ---- shared helpers ---------------------------------------------------------

/** Mutable per-call context: redaction flag and clamped inputs. */
interface CallContext {
  deps: WorkspaceBridgeDeps
  clientId: string
  args: Record<string, unknown>
  adjusted: Adjustments
  redacted: boolean
}

function redactText(ctx: CallContext, text: string): string {
  const out = ctx.deps.redact(text)
  if (out.redacted) ctx.redacted = true
  return out.text
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" ? value : undefined
}

function bool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true
}

function secretRefusal(path: string): ToolFailure {
  return toolFailure(
    "secret_path",
    "authorization",
    `'${path}' is a credential path or repository internal; the bridge never reads or writes it`
  )
}

function notFound(what: string): ToolFailure {
  return toolFailure("not_found", "validation", `${what} does not exist`)
}

/**
 * Resolve `root` + the path argument named `pathKey` (or the root itself when
 * `pathKey` is `null`) and refuse a secret-tier target.
 */
async function target(
  ctx: CallContext,
  pathKey: string | null = "path"
): Promise<{ root: GrantedRoot; relPath: string } | ToolFailure> {
  const resolved = await resolveTarget(
    ctx.clientId,
    ctx.args.root,
    pathKey === null ? undefined : ctx.args[pathKey],
    ctx.deps.grants
  )
  if (!resolved.ok) {
    return toolFailure(
      resolved.code,
      resolved.code === "root_not_granted" ? "authorization" : "validation",
      resolved.error,
      resolved.code === "root_not_granted"
        ? {
            followUp: {
              tool: "workspace_roots",
              arguments: {},
              mechanicallyFollowable: true,
              why: "lists the root ids this client may use",
            },
          }
        : {}
    )
  }
  if (resolved.relPath && isSecretWorkspacePath(resolved.relPath)) {
    return secretRefusal(resolved.relPath)
  }
  return { root: resolved.root, relPath: resolved.relPath }
}

function isFailure(value: unknown): value is ToolFailure {
  return Boolean(value) && (value as { ok?: unknown }).ok === false
}

function patchOf(diff: GitDiff): string {
  if (diff.isBinary) return ""
  return diff.hunks
    .map((hunk) => hunk.patch.trim())
    .filter(Boolean)
    .join("\n")
}

function withoutSecrets(changes: GitFileChange[]): GitFileChange[] {
  return changes.filter(
    (change) =>
      !isSecretWorkspacePath(change.path) &&
      !(change.origPath && isSecretWorkspacePath(change.origPath))
  )
}

function compactChange(change: GitFileChange): Record<string, unknown> {
  return {
    path: change.path,
    status: change.status,
    ...(change.origPath ? { from: change.origPath } : {}),
  }
}

/**
 * The program a command line runs, for labels: leading `NAME=value`
 * assignments are skipped because their values are often credentials.
 */
function commandHead(command: string): string {
  const words = command.trim().split(/\s+/)
  const program = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? ""
  return program.slice(0, 64)
}

// ---- workspace:read ---------------------------------------------------------

async function workspaceRoots(ctx: CallContext) {
  const roots = await resolveGrantedRoots(ctx.clientId, ctx.deps.grants)
  return {
    ok: true as const,
    roots: roots.map((root) => ({ id: root.id, label: root.label, workspace: root.workspace })),
    ...(roots.length === 0
      ? {
          note: "no roots are granted to this client; the user grants them in Settings → External Bridge → Workspace access",
        }
      : {}),
  }
}

async function workspaceList(ctx: CallContext) {
  const resolved = await target(ctx)
  if (isFailure(resolved)) return resolved
  const depth = clampInput("depth", ctx.args.depth, { min: 1, max: 8, fallback: 2 }, ctx.adjusted)
  const maxEntries = clampInput(
    "maxEntries",
    ctx.args.maxEntries,
    { min: 1, max: 2000, fallback: 500 },
    ctx.adjusted
  )
  const includeBulk = bool(ctx.args, "includeBulk")
  const walk = await ctx.deps.fs.walk(resolved.root.path, {
    ...(resolved.relPath ? { relPath: resolved.relPath } : {}),
    includeDirs: true,
    maxEntries,
    maxDepth: depth,
  })
  let secret = walk.skippedSensitive
  let bulk = 0
  const entries: Array<Record<string, unknown>> = []
  for (const entry of walk.entries) {
    const tier = classifyWorkspacePath(entry.relPath)
    if (tier === "secret") {
      secret += 1
      continue
    }
    if (tier === "bulk" && !includeBulk) {
      bulk += 1
      continue
    }
    entries.push(
      entry.isDir ? { path: entry.relPath, dir: true } : { path: entry.relPath, size: entry.size }
    )
  }
  return {
    ok: true as const,
    entries,
    ...(walk.truncated ? { truncated: true } : {}),
    ...(secret > 0 || bulk > 0 ? { hidden: { secret, bulk } } : {}),
  }
}

async function workspaceRead(ctx: CallContext) {
  const resolved = await target(ctx)
  if (isFailure(resolved)) return resolved
  if (!resolved.relPath) {
    return toolFailure("is_directory", "validation", "path names the root; use workspace_list")
  }
  const stat = await ctx.deps.fs.stat(resolved.root.path, resolved.relPath)
  if (!stat.exists) return notFound(resolved.relPath)
  if (stat.isDir) {
    return toolFailure("is_directory", "validation", `'${resolved.relPath}' is a directory`, {
      followUp: {
        tool: "workspace_list",
        arguments: { root: resolved.root.id, path: resolved.relPath },
        mechanicallyFollowable: true,
        why: "lists the directory instead",
      },
    })
  }
  if (stat.isSymlink) {
    // The link's target gets no classification of its own here, so a link
    // named `notes` pointing at `.env` would read a credential.
    return toolFailure(
      "symlink_not_followed",
      "authorization",
      `'${resolved.relPath}' is a symbolic link; read the file it points to by its own path`
    )
  }
  const maxBytes = clampInput(
    "maxBytes",
    ctx.args.maxBytes,
    { min: 1024, max: 1024 * 1024, fallback: 256 * 1024 },
    ctx.adjusted
  )
  const offset = clampInput(
    "offset",
    ctx.args.offset,
    { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: 1 },
    ctx.adjusted
  )
  const limit = clampInput(
    "limit",
    ctx.args.limit,
    { min: 1, max: 5000, fallback: 2000 },
    ctx.adjusted
  )
  const text = await ctx.deps.fs.read(resolved.root.path, resolved.relPath, maxBytes)
  const truncatedBytes = stat.size > maxBytes
  const lines = text.split("\n")
  if (truncatedBytes) {
    // The host cuts mid-line and appends a "... (truncated)" marker line;
    // neither is file content. Only whole lines inside the budget are served
    // (the host reads from byte 0, so nothing past it is reachable here —
    // `workspace_search` finds lines further down).
    lines.splice(Math.max(1, lines.length - 2))
  }
  const from = Math.min(offset, Math.max(1, lines.length))
  if (from !== offset) ctx.adjusted.offset = { requested: offset, effective: from }
  const slice = lines.slice(from - 1, from - 1 + limit)
  const to = from + slice.length - 1
  const moreLines = to < lines.length
  return {
    ok: true as const,
    content: redactText(ctx, slice.join("\n")),
    lines: { from, to, total: truncatedBytes ? null : lines.length },
    ...(truncatedBytes ? { truncatedAtBytes: maxBytes } : {}),
    ...(moreLines
      ? {
          next: {
            tool: "workspace_read",
            arguments: { root: resolved.root.id, path: resolved.relPath, offset: to + 1, limit },
          },
        }
      : {}),
  }
}

async function workspaceSearch(ctx: CallContext) {
  const resolved = await target(ctx)
  if (isFailure(resolved)) return resolved
  const query = str(ctx.args, "query")?.trim()
  if (!query) return toolFailure("invalid_query", "validation", "query must be a non-empty string")
  const mode = ctx.args.mode === "name" ? "name" : "content"
  const maxResults = clampInput(
    "maxResults",
    ctx.args.maxResults,
    { min: 1, max: 200, fallback: 50 },
    ctx.adjusted
  )
  const includeBulk = bool(ctx.args, "includeBulk")
  const prefix = resolved.relPath ? `${resolved.relPath}/` : ""
  const inScope = (relPath: string) =>
    (!prefix || relPath === resolved.relPath || relPath.startsWith(prefix)) &&
    (() => {
      const tier = classifyWorkspacePath(relPath)
      return tier === "ordinary" || (tier === "bulk" && includeBulk)
    })()

  if (mode === "name") {
    const hits = await ctx.deps.fs.searchNames(resolved.root.path, query, maxResults)
    const matches = hits
      .filter((hit) => inScope(hit.relPath))
      .map((hit) => (hit.isDir ? { path: hit.relPath, dir: true } : { path: hit.relPath }))
    return { ok: true as const, matches, ...(hits.length >= maxResults ? { truncated: true } : {}) }
  }

  // Over-fetch so filtered-out hits do not starve the page.
  const hits = await ctx.deps.fs.searchContent(resolved.root.path, query, {
    isRegex: bool(ctx.args, "regex"),
    caseSensitive: bool(ctx.args, "caseSensitive"),
    maxResults: Math.min(500, maxResults * 2),
  })
  const kept = hits.filter((hit) => inScope(hit.relPath))
  const matches = kept.slice(0, maxResults).map((hit) => ({
    path: hit.relPath,
    line: hit.line,
    text: redactText(ctx, hit.preview),
  }))
  return {
    ok: true as const,
    matches,
    ...(kept.length > maxResults || hits.length >= Math.min(500, maxResults * 2)
      ? { truncated: true }
      : {}),
  }
}

// ---- workspace:write --------------------------------------------------------

function placeholderRefusal(field: string): ToolFailure {
  return toolFailure(
    "redaction_placeholder",
    "validation",
    `${field} contains a PII redaction placeholder (like <EMAIL_001>) from an earlier read; ` +
      "writing it would replace the real text. Leave that span out of the edit."
  )
}

async function workspaceWrite(ctx: CallContext) {
  const resolved = await target(ctx)
  if (isFailure(resolved)) return resolved
  if (!resolved.relPath) return toolFailure("invalid_path", "validation", "path names the root")
  const content = str(ctx.args, "content")
  if (content === undefined)
    return toolFailure("invalid_content", "validation", "content must be a string")
  if (ctx.deps.hasPlaceholder(content)) return placeholderRefusal("content")
  const stat = await ctx.deps.fs.stat(resolved.root.path, resolved.relPath)
  if (stat.isDir)
    return toolFailure("is_directory", "validation", `'${resolved.relPath}' is a directory`)
  if (ctx.args.mode === "create" && stat.exists) {
    return toolFailure("already_exists", "validation", `'${resolved.relPath}' already exists`, {
      followUp: {
        tool: "workspace_write",
        arguments: { root: resolved.root.id, path: resolved.relPath, mode: "overwrite" },
        mechanicallyFollowable: false,
        why: "overwrites it — only if replacing the existing file is intended",
      },
    })
  }
  await ctx.deps.fs.write(resolved.root.path, resolved.relPath, content)
  return {
    ok: true as const,
    created: !stat.exists,
    bytes: new TextEncoder().encode(content).length,
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

async function workspaceEdit(ctx: CallContext) {
  const resolved = await target(ctx)
  if (isFailure(resolved)) return resolved
  const oldString = str(ctx.args, "oldString")
  const newString = str(ctx.args, "newString")
  if (!oldString || newString === undefined) {
    return toolFailure(
      "invalid_edit",
      "validation",
      "oldString (non-empty) and newString are required"
    )
  }
  if (oldString === newString) {
    return toolFailure("invalid_edit", "validation", "oldString and newString are identical")
  }
  if (ctx.deps.hasPlaceholder(oldString)) return placeholderRefusal("oldString")
  if (ctx.deps.hasPlaceholder(newString)) return placeholderRefusal("newString")
  const stat = await ctx.deps.fs.stat(resolved.root.path, resolved.relPath)
  if (!stat.exists) return notFound(resolved.relPath)
  if (stat.isDir)
    return toolFailure("is_directory", "validation", `'${resolved.relPath}' is a directory`)
  if (stat.isSymlink) {
    return toolFailure(
      "symlink_not_followed",
      "authorization",
      `'${resolved.relPath}' is a symbolic link; edit the file it points to by its own path`
    )
  }
  if (stat.size > EDIT_MAX_BYTES) {
    return toolFailure(
      "file_too_large",
      "validation",
      `'${resolved.relPath}' is ${stat.size} bytes; workspace_edit handles files up to ${EDIT_MAX_BYTES}`,
      {
        followUp: {
          tool: "workspace_write",
          arguments: { root: resolved.root.id, path: resolved.relPath },
          mechanicallyFollowable: false,
          why: "replaces the whole file — only with its complete new content",
        },
      }
    )
  }
  const original = await ctx.deps.fs.read(resolved.root.path, resolved.relPath)
  const occurrences = countOccurrences(original, oldString)
  if (occurrences === 0) {
    return toolFailure("no_match", "validation", "oldString does not occur in the file", {
      followUp: {
        tool: "workspace_read",
        arguments: { root: resolved.root.id, path: resolved.relPath },
        mechanicallyFollowable: true,
        why: "re-reads the current text to copy oldString from",
      },
    })
  }
  const replaceAll = bool(ctx.args, "replaceAll")
  if (occurrences > 1 && !replaceAll) {
    return toolFailure(
      "ambiguous_match",
      "validation",
      `oldString occurs ${occurrences} times; include more context or set replaceAll`,
      {
        followUp: {
          tool: "workspace_edit",
          arguments: {
            root: resolved.root.id,
            path: resolved.relPath,
            oldString,
            newString,
            replaceAll: true,
          },
          mechanicallyFollowable: false,
          why: "replaces every occurrence — only if all of them should change",
        },
      }
    )
  }
  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, () => newString)
  await ctx.deps.fs.write(resolved.root.path, resolved.relPath, updated)
  return { ok: true as const, replacements: replaceAll ? occurrences : 1 }
}

async function workspaceMove(ctx: CallContext) {
  const from = await target(ctx, "from")
  if (isFailure(from)) return from
  const to = normalizeRelPath(ctx.args.to)
  if (!from.relPath || !to) {
    return toolFailure("invalid_path", "validation", "from and to must name paths inside the root")
  }
  if (isSecretWorkspacePath(to)) return secretRefusal(to)
  const stat = await ctx.deps.fs.stat(from.root.path, from.relPath)
  if (!stat.exists) return notFound(from.relPath)
  const destination = await ctx.deps.fs.stat(from.root.path, to)
  if (destination.exists) {
    return toolFailure(
      "already_exists",
      "validation",
      `'${to}' already exists; move never overwrites`
    )
  }
  await ctx.deps.fs.rename(from.root.path, from.relPath, to)
  return { ok: true as const }
}

async function workspaceDelete(ctx: CallContext) {
  const resolved = await target(ctx)
  if (isFailure(resolved)) return resolved
  if (!resolved.relPath) {
    return toolFailure("invalid_path", "validation", "refusing to delete a workspace root")
  }
  const stat = await ctx.deps.fs.stat(resolved.root.path, resolved.relPath)
  if (!stat.exists) return notFound(resolved.relPath)
  const recursive = bool(ctx.args, "recursive")
  const reason = await ctx.deps.translate("workspaceApproval.deleteReason", {
    client: ctx.clientId,
    path: `${resolved.root.label}/${resolved.relPath}`,
    kind: stat.isDir ? "directory" : "file",
  })
  const approved = await ctx.deps.requestConsent({
    consentId: WORKSPACE_BRIDGE_PER_CALL_CONSENT_ID,
    reason,
  })
  if (!approved) return toolFailure("approval_denied", "consent", "the user declined the delete")
  await ctx.deps.fs.remove(resolved.root.path, resolved.relPath, stat.isDir ? recursive : undefined)
  return { ok: true as const }
}

// ---- git:read ---------------------------------------------------------------

async function repoTarget(ctx: CallContext) {
  const resolved = await target(ctx, null)
  if (isFailure(resolved)) return resolved
  // libgit2 discovers a repository by walking UP from the path it is given,
  // so a root nested inside a bigger repository would expose that repository.
  // Git tools therefore need the granted root to BE the repository root.
  const dotGit = await ctx.deps.fs.stat(resolved.root.path, ".git")
  if (!dotGit.exists) {
    const inside = await ctx.deps.git.isRepo(resolved.root.path)
    return toolFailure(
      inside ? "not_repo_root" : "not_a_repo",
      "validation",
      inside
        ? `root '${resolved.root.id}' is inside a repository but is not its root; grant the repository root to use git tools`
        : `root '${resolved.root.id}' is not a git repository`
    )
  }
  if (!(await ctx.deps.git.isRepo(resolved.root.path))) {
    return toolFailure(
      "not_a_repo",
      "validation",
      `root '${resolved.root.id}' is not a git repository`
    )
  }
  return resolved.root
}

async function gitStatusTool(ctx: CallContext) {
  const root = await repoTarget(ctx)
  if (isFailure(root)) return root
  const status = await ctx.deps.git.status(root.path)
  const all = [...status.staged, ...status.changes, ...status.merge]
  const hidden = all.length - withoutSecrets(all).length
  return {
    ok: true as const,
    branch: status.branch,
    ...(status.upstream
      ? { upstream: status.upstream, ahead: status.ahead, behind: status.behind }
      : {}),
    staged: withoutSecrets(status.staged).map(compactChange),
    changes: withoutSecrets(status.changes).map(compactChange),
    ...(status.merge.length > 0
      ? { conflicts: withoutSecrets(status.merge).map(compactChange) }
      : {}),
    ...(status.isRebasing ? { rebasing: true } : {}),
    ...(status.isMerging ? { merging: true } : {}),
    ...(hidden > 0 ? { hidden: { secret: hidden } } : {}),
  }
}

async function gitDiffTool(ctx: CallContext) {
  const root = await repoTarget(ctx)
  if (isFailure(root)) return root
  const maxChars = clampInput(
    "maxChars",
    ctx.args.maxChars,
    { min: 1000, max: 200_000, fallback: 40_000 },
    ctx.adjusted
  )
  const staged = ctx.args.staged
  const rawPath = ctx.args.path
  if (rawPath !== undefined && rawPath !== "") {
    const path = normalizeRelPath(rawPath)
    if (!path) return toolFailure("invalid_path", "validation", "path must be relative to the root")
    if (isSecretWorkspacePath(path)) return secretRefusal(path)
    const patch = patchOf(await ctx.deps.git.diffFile(root.path, path, staged === true))
    const clipped = patch.length > maxChars ? patch.slice(0, maxChars) : patch
    return {
      ok: true as const,
      diff: redactText(ctx, clipped),
      ...(clipped.length < patch.length ? { truncated: true } : {}),
    }
  }
  // Whole tree: reuse the verifier's reader with a status that has the
  // credential paths (and, when asked, one side of the index) removed.
  const status = async (repoPath: string): Promise<GitStatus> => {
    const full = await ctx.deps.git.status(repoPath)
    return {
      ...full,
      staged: staged === false ? [] : withoutSecrets(full.staged),
      changes: staged === true ? [] : withoutSecrets(full.changes),
      merge: staged === true ? [] : withoutSecrets(full.merge),
    }
  }
  const snapshot = await ctx.deps.git.workspaceDiff(root.path, { maxChars, status })
  return {
    ok: true as const,
    diff: redactText(ctx, snapshot.text),
    files: snapshot.fileCount,
    ...(snapshot.truncated ? { truncated: true } : {}),
  }
}

function compactCommit(ctx: CallContext, commit: GitCommit): Record<string, unknown> {
  // Author e-mail is left out on purpose: it is PII and no coding task needs it.
  return {
    hash: commit.hash,
    summary: redactText(ctx, commit.summary),
    author: redactText(ctx, commit.authorName),
    date: new Date(commit.authoredAtMs).toISOString(),
  }
}

async function gitLogTool(ctx: CallContext) {
  const root = await repoTarget(ctx)
  if (isFailure(root)) return root
  const limit = clampInput(
    "limit",
    ctx.args.limit,
    { min: 1, max: 100, fallback: 20 },
    ctx.adjusted
  )
  const skip = clampInput(
    "skip",
    ctx.args.skip,
    { min: 0, max: 100_000, fallback: 0 },
    ctx.adjusted
  )
  const rawPath = ctx.args.path
  let commits: GitCommit[]
  if (rawPath !== undefined && rawPath !== "") {
    const path = normalizeRelPath(rawPath)
    if (!path) return toolFailure("invalid_path", "validation", "path must be relative to the root")
    if (isSecretWorkspacePath(path)) return secretRefusal(path)
    commits = await ctx.deps.git.fileHistory(root.path, path, limit)
  } else {
    commits = await ctx.deps.git.log(root.path, limit, skip)
  }
  return {
    ok: true as const,
    commits: commits.map((commit) => compactCommit(ctx, commit)),
    ...(commits.length === limit && !rawPath
      ? { next: { tool: "git_log", arguments: { root: root.id, limit, skip: skip + limit } } }
      : {}),
  }
}

async function gitShowTool(ctx: CallContext) {
  const root = await repoTarget(ctx)
  if (isFailure(root)) return root
  const rev = str(ctx.args, "rev")?.trim()
  // A revision is an identity input: refuse anything that is not a plain ref.
  if (!rev || !/^[A-Za-z0-9._/~^@{}-]{1,200}$/.test(rev) || rev.startsWith("-")) {
    return toolFailure("invalid_rev", "validation", "rev must be a commit hash or ref name")
  }
  const rawPath = ctx.args.path
  if (rawPath !== undefined && rawPath !== "") {
    const path = normalizeRelPath(rawPath)
    if (!path) return toolFailure("invalid_path", "validation", "path must be relative to the root")
    if (isSecretWorkspacePath(path)) return secretRefusal(path)
    const maxChars = clampInput(
      "maxChars",
      ctx.args.maxChars,
      { min: 1000, max: 200_000, fallback: 40_000 },
      ctx.adjusted
    )
    const patch = patchOf(await ctx.deps.git.diffCommit(root.path, rev, path))
    const clipped = patch.length > maxChars ? patch.slice(0, maxChars) : patch
    return {
      ok: true as const,
      diff: redactText(ctx, clipped),
      ...(clipped.length < patch.length ? { truncated: true } : {}),
    }
  }
  const files = await ctx.deps.git.commitFiles(root.path, rev)
  const kept = withoutSecrets(files)
  return {
    ok: true as const,
    files: kept.map(compactChange),
    ...(kept.length < files.length ? { hidden: { secret: files.length - kept.length } } : {}),
  }
}

// ---- shell:run --------------------------------------------------------------

const WAIT_SPEC = { min: 0, max: 30_000, fallback: 10_000 }
const OUTPUT_SPEC = { min: 1024, max: 64 * 1024, fallback: 16 * 1024 }

/**
 * Collect a job's output from `fromOffset` until it settles, the byte budget
 * fills, or the wait budget runs out — one long-poll per round, no sleeps.
 */
async function collectOutput(
  ctx: CallContext,
  jobId: string,
  fromOffset: number,
  waitMs: number,
  maxBytes: number
): Promise<{
  data: string
  nextOffset: number
  status: string
  exitCode?: number
  hasMore: boolean
}> {
  const deadline = ctx.deps.now() + waitMs
  let data = ""
  let bytes = 0
  let offset = fromOffset
  let last: BackgroundJobOutput | null = null
  for (;;) {
    const remaining = Math.max(0, deadline - ctx.deps.now())
    const budget = maxBytes - bytes
    last = await ctx.deps.jobs.wait(jobId, offset, {
      maxBytes: Math.max(1, budget),
      waitMs: remaining,
    })
    data += last.data
    // The host budget is in bytes; `nextOffset` is the byte cursor it used.
    bytes += last.nextOffset - offset
    offset = last.nextOffset
    const settled = last.status !== "running"
    if (bytes >= maxBytes) break
    if (settled && !last.hasMore) break
    if (!settled && remaining === 0) break
    if (!settled && last.data.length === 0 && ctx.deps.now() >= deadline) break
  }
  return {
    data,
    nextOffset: offset,
    status: last.status,
    ...(typeof last.exitCode === "number" ? { exitCode: last.exitCode } : {}),
    hasMore: last.hasMore,
  }
}

function jobResult(
  ctx: CallContext,
  jobId: string,
  collected: Awaited<ReturnType<typeof collectOutput>>,
  maxBytes: number
) {
  const running = collected.status === "running"
  const output = redactText(ctx, collected.data)
  if (running) {
    return {
      ok: true as const,
      jobId,
      output,
      ...pendingMarker("job_output", { jobId, fromOffset: collected.nextOffset }),
    }
  }
  ctx.deps.attention.markObserved(ctx.clientId, jobId)
  return {
    ok: true as const,
    jobId,
    status: collected.status,
    ...(collected.exitCode !== undefined ? { exitCode: collected.exitCode } : {}),
    output,
    ...(collected.hasMore
      ? {
          truncated: true,
          next: {
            tool: "job_output",
            arguments: { jobId, fromOffset: collected.nextOffset, maxBytes },
          },
        }
      : {}),
  }
}

async function shellRun(ctx: CallContext) {
  const resolved = await target(ctx, "cwd")
  if (isFailure(resolved)) return resolved
  const command = str(ctx.args, "command")?.trim()
  if (!command)
    return toolFailure("invalid_command", "validation", "command must be a non-empty string")
  const cwd = resolved.relPath
    ? `${resolved.root.path.replace(/[\\/]+$/, "")}/${resolved.relPath}`
    : resolved.root.path
  const cwdStat = await ctx.deps.fs.stat(resolved.root.path, resolved.relPath)
  if (resolved.relPath && (!cwdStat.exists || !cwdStat.isDir)) {
    return toolFailure("invalid_cwd", "validation", `cwd '${resolved.relPath}' is not a directory`)
  }

  const verdict = ctx.deps.classify(command, cwd)
  if (verdict.verdict === "deny") {
    return toolFailure("command_denied", "authorization", `refused: ${verdict.reason}`)
  }
  const touchesSecret = commandTouchesSecretPath(command)
  if (verdict.verdict === "ask" || touchesSecret) {
    const reason = await ctx.deps.translate(
      touchesSecret ? "workspaceApproval.commandReasonSecret" : "workspaceApproval.commandReason",
      { client: ctx.clientId, command: command.slice(0, 400), root: resolved.root.label }
    )
    const approved = await ctx.deps.requestConsent({
      consentId: WORKSPACE_BRIDGE_PER_CALL_CONSENT_ID,
      reason,
    })
    if (!approved) return toolFailure("approval_denied", "consent", "the user declined the command")
  }

  const waitMs = clampInput("waitMs", ctx.args.waitMs, WAIT_SPEC, ctx.adjusted)
  const maxBytes = clampInput("maxBytes", ctx.args.maxBytes, OUTPUT_SPEC, ctx.adjusted)
  // Subscribe before spawning so a fast exit cannot slip past the feed. A
  // failed subscription costs only the piggyback, never the command.
  await ctx.deps.attention.ensureSubscribed().catch(() => undefined)
  // The label resurfaces later as attention, outside this call's PII gate.
  const label = ctx.deps.redact(commandHead(command)).text
  const job = await ctx.deps.jobs.spawn({ clientId: ctx.clientId, command, cwd, label })
  ctx.deps.attention.noteSpawned(job.id, label)
  const collected = await collectOutput(ctx, job.id, 0, waitMs, maxBytes)
  return jobResult(ctx, job.id, collected, maxBytes)
}

async function ownedJob(ctx: CallContext): Promise<BackgroundJobRecord | ToolFailure> {
  // After a renderer reload the feed is gone until someone subscribes again.
  await ctx.deps.attention.ensureSubscribed().catch(() => undefined)
  const jobId = str(ctx.args, "jobId")
  if (!jobId) return toolFailure("invalid_job", "validation", "jobId is required")
  const jobs = await ctx.deps.jobs.list(ctx.clientId)
  const job = jobs.find((candidate) => candidate.id === jobId)
  if (!job) {
    return toolFailure(
      "job_not_found",
      "validation",
      `job '${jobId}' was not started by this client`,
      {
        followUp: {
          tool: "job_list",
          arguments: {},
          mechanicallyFollowable: true,
          why: "lists this client's jobs",
        },
      }
    )
  }
  return job
}

async function jobOutput(ctx: CallContext) {
  const job = await ownedJob(ctx)
  if (isFailure(job)) return job
  const fromOffset = clampInput(
    "fromOffset",
    ctx.args.fromOffset,
    { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 },
    ctx.adjusted
  )
  const waitMs = clampInput("waitMs", ctx.args.waitMs, WAIT_SPEC, ctx.adjusted)
  const maxBytes = clampInput("maxBytes", ctx.args.maxBytes, OUTPUT_SPEC, ctx.adjusted)
  const collected = await collectOutput(ctx, job.id, fromOffset, waitMs, maxBytes)
  return jobResult(ctx, job.id, collected, maxBytes)
}

async function jobList(ctx: CallContext) {
  await ctx.deps.attention.ensureSubscribed().catch(() => undefined)
  const jobs = await ctx.deps.jobs.list(ctx.clientId)
  return {
    ok: true as const,
    jobs: jobs.map((job) => ({
      jobId: job.id,
      command: redactText(ctx, job.command.slice(0, 200)),
      status: job.status,
      ...(typeof job.exitCode === "number" ? { exitCode: job.exitCode } : {}),
      startedAt: new Date(job.startedAtMs).toISOString(),
    })),
  }
}

async function jobKill(ctx: CallContext) {
  const job = await ownedJob(ctx)
  if (isFailure(job)) return job
  if (job.status !== "running") {
    ctx.deps.attention.markObserved(ctx.clientId, job.id)
    return { ok: true as const, status: job.status, alreadyFinished: true }
  }
  const killed = await ctx.deps.jobs.kill(job.id)
  ctx.deps.attention.markObserved(ctx.clientId, job.id)
  return { ok: true as const, status: killed.status }
}

// ---- dispatch ---------------------------------------------------------------

const HANDLERS: Record<WorkspaceToolName, (ctx: CallContext) => Promise<Record<string, unknown>>> =
  {
    workspace_roots: workspaceRoots,
    workspace_list: workspaceList,
    workspace_read: workspaceRead,
    workspace_search: workspaceSearch,
    workspace_write: workspaceWrite,
    workspace_edit: workspaceEdit,
    workspace_move: workspaceMove,
    workspace_delete: workspaceDelete,
    git_status: gitStatusTool,
    git_diff: gitDiffTool,
    git_log: gitLogTool,
    git_show: gitShowTool,
    shell_run: shellRun,
    job_output: jobOutput,
    job_list: jobList,
    job_kill: jobKill,
  }

/** Tools whose failure after dispatch may have changed state. */
const MUTATING_TOOLS: ReadonlySet<WorkspaceToolName> = new Set([
  "workspace_write",
  "workspace_edit",
  "workspace_move",
  "workspace_delete",
  "shell_run",
  "job_kill",
])

/**
 * Host error text quotes absolute paths ("path escapes workspace: /Users/…").
 * Tools promise root-relative addressing and never hand out a root's absolute
 * path, so errors must not either: a granted root becomes `<root:id>`, and any
 * remaining home directory becomes `~`.
 */
export function scrubHostPaths(text: string, roots: readonly GrantedRoot[]): string {
  let out = text
  for (const root of [...roots].sort((a, b) => b.path.length - a.path.length)) {
    const trimmed = root.path.replace(/[\\/]+$/, "")
    if (trimmed) out = out.split(trimmed).join(`<root:${root.id}>`)
  }
  return out.replace(/(?:\/Users|\/home|[A-Za-z]:\\Users)[\\/][^\\/\s"']+/g, "~")
}

const PII_BLOCKED_ERROR =
  "the result contained personal data that could not be redacted, so it was withheld"

async function isPiiFree(deps: WorkspaceBridgeDeps, value: unknown): Promise<boolean> {
  try {
    return await deps.piiFree(value)
  } catch {
    // A gate that cannot run is a closed gate.
    return false
  }
}

/** Renderer-side execution: validate → resolve → (approve) → run → redact → gate. */
export async function workspaceToolCore(input: WorkspaceToolInput): Promise<WorkspaceToolOutput> {
  if (!isWorkspaceToolName(input.tool)) {
    return toolFailure(
      "unknown_tool",
      "validation",
      `unknown workspace tool '${String(input.tool)}'`
    )
  }
  const deps = depsOverride ?? (await defaultDeps())
  if (!deps.hostSupported()) {
    return toolFailure(
      "desktop_only",
      "execution",
      "workspace, git and shell tools run only on the Cognia desktop app that owns the files, " +
        "not on a headless host or while this app is controlling a remote host"
    )
  }
  const ctx: CallContext = {
    deps,
    clientId: input.clientId || "mcp:stdio",
    args: input.args && typeof input.args === "object" ? input.args : {},
    adjusted: {},
    redacted: false,
  }
  let result: Record<string, unknown>
  try {
    result = await HANDLERS[input.tool](ctx)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const roots = await resolveGrantedRoots(ctx.clientId, deps.grants).catch(() => [])
    const { text, redacted } = deps.redact(scrubHostPaths(raw, roots))
    if (redacted) ctx.redacted = true
    const safe = await isPiiFree(deps, text)
    result = toolFailure(
      safe ? "host_error" : "pii_blocked",
      "execution",
      safe ? text : PII_BLOCKED_ERROR,
      MUTATING_TOOLS.has(input.tool) ? { outcomeUnknown: true } : {}
    )
  }
  if (result.ok !== false && !(await isPiiFree(deps, result))) {
    result = toolFailure("pii_blocked", "execution", PII_BLOCKED_ERROR, {
      stateChanged: MUTATING_TOOLS.has(input.tool),
    })
  }
  const attention = deps.attention.drain(ctx.clientId)
  return {
    ...result,
    ...(result.ok !== false ? adjustedField(ctx.adjusted) : {}),
    ...(ctx.redacted ? { redacted: true } : {}),
    ...(attention ? { attention } : {}),
  } as WorkspaceToolOutput
}

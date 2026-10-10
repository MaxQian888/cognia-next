import type { ChatSession, SessionRole } from "@cognia/agent-config-types"
import type { WorkspaceEntry } from "@/lib/files/types"
import type { LoadedConversationFileSpace } from "@/lib/filespace/load"
import { locateFileSpacePath, normalizeFileSpacePath } from "@/lib/filespace/paths"
import type { EffectiveFileSharingPolicy } from "@/lib/filespace/policy"
import { isSensitiveDirectory, isSensitivePath } from "@/lib/filespace/sensitive"
import type { CreateFileShareInput } from "@/lib/filespace/share-files"
import type { SharedLinkRow } from "@/lib/db/shared-links"
import type { CreatedShare } from "@/lib/share/client"
import {
  checkShareSelectionLimits,
  type ExpandedShareSelection,
  type ShareSelectionLimitViolation,
} from "@/lib/share/file-selection"
import { fileBundlePayload } from "@/lib/share/payload"
import type { ConversationFileSpace, FileSpacePath } from "@/types/filespace"
import type {
  CreatedLiveGrant,
  CreateLiveGrantRequest,
  LiveGrantView,
  LivePermission,
  LiveProtocol,
  LiveProvider,
} from "@/types/filespace/live"

/**
 * Built-in tools for a conversation's files (ADR-0222 §9): what the agent of
 * a conversation may see of its FileSpace and do with its shares. Same family
 * shape as the artifact and project tools: a name map, manifest entries with
 * hand-written JSON Schema, a predicate, and a runner that never throws. Every
 * host effect goes through {@link FilespaceToolDeps}, wired in
 * `lib/filespace/agent-tool-deps.ts`.
 *
 * - `filespace_list`, `filespace_revoke_share` and `filespace_disable_webdav`
 *   are allowed without asking (`filespace-tool-rules.ts`): reading the
 *   conversation's own files and taking access away.
 * - `filespace_share` and `filespace_enable_webdav` give someone else access.
 *   They are offered only when the effective policy allows agent sharing,
 *   ask the person on every call (`requiresApproval` + the sidecar's
 *   per-call list, so "allow always" cannot be remembered for them), classify
 *   as `external-send`, and the runner re-checks the policy because it can
 *   change between the manifest and the call. The host refuses an agent's
 *   live grant on its own without the policy (`CreatedBy::Agent`).
 *
 * Invariants:
 * - The conversation is always the calling one (`context.sessionId`); an
 *   empty id fails rather than falling back to whatever is open.
 * - Paths must lie inside this conversation's FileSpace, and the sensitive
 *   floor has no agent override: a file it refuses is left out and named.
 * - A result never carries a password. A live credential's password exists
 *   only in the host's create answer, which the runner drops; the person
 *   issues one from the result card (`FilespaceShareCard`) or the Files
 *   panel, on whichever device they are using.
 */

export const FILESPACE_BUILTIN_PLUGIN_ID = "cognia-filespace-builtin"

export const FILESPACE_TOOL_NAMES = {
  list: "filespace_list",
  share: "filespace_share",
  revokeShare: "filespace_revoke_share",
  enableWebdav: "filespace_enable_webdav",
  disableWebdav: "filespace_disable_webdav",
} as const

/** The tools that give someone else access: asked per call, gated on policy. */
export const FILESPACE_SHARING_TOOL_NAMES: ReadonlySet<string> = new Set([
  FILESPACE_TOOL_NAMES.share,
  FILESPACE_TOOL_NAMES.enableWebdav,
])

const ALL_TOOLS = new Set<string>(Object.values(FILESPACE_TOOL_NAMES))

/** At most this many paths per share, as the host accepts. */
export const MAX_SHARE_PATHS = 50
/** At most this many entries per listing. */
export const MAX_LISTED_ENTRIES = 200
const MAX_LABEL_CHARS = 120
const DEFAULT_SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_LIVE_TTL_SECONDS = 24 * 60 * 60

export interface FilespaceManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
  /**
   * Every call asks a human; with the sidecar's `PER_CALL_PLUGIN_TOOL_NAMES`
   * no remembered grant, mode or auto-answer skips it.
   */
  requiresApproval?: true
}

function entry(
  name: string,
  description: string,
  jsonSchema: Record<string, unknown>,
  requiresApproval = false
): FilespaceManifestEntry {
  return {
    name,
    description,
    jsonSchema,
    pluginId: FILESPACE_BUILTIN_PLUGIN_ID,
    ...(requiresApproval ? { requiresApproval: true as const } : {}),
  }
}

const pathsSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_SHARE_PATHS,
  items: { type: "string", minLength: 1 },
  description:
    "FileSpace paths from filespace_list, e.g. /workspace/src or /uploads/report.pdf. A folder covers everything under it.",
}

/**
 * The manifest. `sharing` adds the two tools that give access away; it is
 * true only when the effective policy allows agent sharing.
 */
export function buildFilespaceManifestEntries(options: {
  sharing: boolean
}): FilespaceManifestEntry[] {
  const T = FILESPACE_TOOL_NAMES
  const entries = [
    entry(
      T.list,
      "List this conversation's files: its mounts (/workspace, /roots/<id>, /uploads, /artifacts), the entries directly under one path, and the links and network-drive access already shared from it. Paths here are the ones every other filespace tool takes.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description:
              "List the entries directly under this FileSpace path. Omit for mounts only.",
          },
        },
      }
    ),
    entry(
      T.revokeShare,
      "Revoke a share link (by code) or network-drive access (by grant id) made from this conversation. Takes effect at once.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "string", minLength: 1, description: "A share link's code." },
          grant_id: { type: "string", minLength: 1, description: "A live grant's id (fg_…)." },
        },
      }
    ),
    entry(
      T.disableWebdav,
      "Revoke every network-drive access of this conversation that speaks WebDAV.",
      { type: "object", additionalProperties: false, properties: {} }
    ),
  ]
  if (!options.sharing) return entries
  return [
    ...entries,
    entry(
      T.share,
      "Share files of this conversation, after the user approves. mode=snapshot publishes an end-to-end encrypted copy as a link anyone holding it can open; the result has the URL. mode=live gives revocable access to the files as they change: by default over WebDAV/SFTP (the result has the addresses and usernames, never a password — the user issues one from the result card), or, in a shared conversation, audience=members gives its members access from the conversation's Files section while this device is online. Files holding secrets (.env, keys, credentials) are always left out.",
      {
        type: "object",
        additionalProperties: false,
        required: ["paths", "mode"],
        properties: {
          paths: pathsSchema,
          mode: { type: "string", enum: ["snapshot", "live"] },
          expires_in_seconds: {
            type: "integer",
            minimum: 3600,
            description:
              "Lifetime. Defaults to 7 days for a snapshot and 1 day for live access, within the policy's ceiling.",
          },
          permissions: {
            type: "array",
            items: { type: "string", enum: ["read", "download", "write"] },
            description:
              "Live only. read is always included; download lets files be fetched (default on); write lets them be changed.",
          },
          protocols: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: ["webdav", "sftp"] },
            description: "Live only. Defaults to webdav (sftp through SFTPGo).",
          },
          provider: {
            type: "string",
            enum: ["builtin", "sftpgo"],
            description: "Live only. Who serves the access; defaults to this computer.",
          },
          audience: {
            type: "string",
            enum: ["credentials", "members"],
            description:
              "Live only. credentials (default): a WebDAV/SFTP sign-in. members: the members of this shared conversation, no sign-in; only for a shared conversation, and protocols/provider do not apply.",
          },
          min_role: {
            type: "string",
            enum: ["viewer", "member", "maintainer", "owner"],
            description:
              "audience=members only. The lowest role admitted (default viewer). A viewer only ever reads.",
          },
          label: { type: "string", maxLength: MAX_LABEL_CHARS },
        },
      },
      true
    ),
    entry(
      T.enableWebdav,
      "Share this conversation's files as a WebDAV network drive, after the user approves: live, revocable access to the files as they change. Defaults to /workspace. The result has the address and username, never a password — the user issues one from the result card.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          paths: {
            ...pathsSchema,
            description: `${pathsSchema.description} Defaults to /workspace.`,
          },
          write: { type: "boolean", default: false, description: "Let the drive change files." },
          expires_in_seconds: { type: "integer", minimum: 3600 },
          label: { type: "string", maxLength: MAX_LABEL_CHARS },
        },
      },
      true
    ),
  ]
}

export function isFilespaceBuiltinTool(name: string): boolean {
  return ALL_TOOLS.has(name)
}

export interface FilespaceToolDeps {
  getSession: (id: string) => Promise<ChatSession | undefined>
  loadFileSpace: (sessionId: string) => Promise<LoadedConversationFileSpace>
  loadPolicy: () => Promise<EffectiveFileSharingPolicy>
  /** Immediate children of a disk directory. */
  listDir: (root: string, relPath?: string) => Promise<WorkspaceEntry[]>
  expandSelection: (
    space: ConversationFileSpace,
    paths: readonly FileSpacePath[]
  ) => Promise<ExpandedShareSelection>
  /** `createFileShare`: the shared-conversation and policy checks, then the upload. */
  createSnapshotShare: (input: CreateFileShareInput) => Promise<CreatedShare>
  /** Working links made from this conversation (revoked ones excluded). */
  listShareLinks: (sessionId: string) => Promise<SharedLinkRow[]>
  revokeShareLink: (code: string) => Promise<void>
  listLiveGrants: (sessionId: string, hostId: string) => Promise<LiveGrantView[]>
  /** `createLiveFileShare`: the shared-conversation check, then the host. */
  createLiveShare: (request: CreateLiveGrantRequest, hostId: string) => Promise<CreatedLiveGrant>
  revokeLiveGrant: (grantId: string, hostId: string) => Promise<LiveGrantView>
  /** The snapshot's title, in the person's language. */
  bundleTitle: (sessionTitle: string | undefined) => Promise<string>
  /** The stable code and words of a refusal (`fileShareErrorDetails` and the share errors). */
  describeError: (error: unknown) => { code: string; message: string }
  now: () => number
}

type ToolError = { ok: false; code?: string; error: string }
const fail = (error: string, code?: string): ToolError => ({
  ok: false,
  ...(code ? { code } : {}),
  error,
})
function isError(value: unknown): value is ToolError {
  return typeof value === "object" && value !== null && (value as ToolError).ok === false
}

export async function runFilespaceBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: FilespaceToolDeps | undefined,
  context: { sessionId: string }
): Promise<unknown> {
  if (!isFilespaceBuiltinTool(name)) return fail(`unknown filespace tool: ${name}`)
  if (!deps) return fail("File sharing host dependencies are unavailable")
  // Bound to the calling conversation, never to whatever happens to be open.
  if (!context.sessionId) return fail("This tool needs the conversation it was called from")
  try {
    const T = FILESPACE_TOOL_NAMES
    switch (name) {
      case T.list:
        return await runList(args, deps, context.sessionId)
      case T.share:
        return await runShare(args, deps, context.sessionId)
      case T.enableWebdav:
        return await runEnableWebdav(args, deps, context.sessionId)
      case T.revokeShare:
        return await runRevoke(args, deps, context.sessionId)
      case T.disableWebdav:
        return await runDisableWebdav(deps, context.sessionId)
    }
    return fail(`unknown filespace tool: ${name}`)
  } catch (error) {
    const { code, message } = deps.describeError(error)
    return fail(message, code === "unknown" ? undefined : code)
  }
}

// ── filespace_list ──────────────────────────────────────────────────────────

async function runList(
  args: Record<string, unknown>,
  deps: FilespaceToolDeps,
  sessionId: string
): Promise<unknown> {
  const { space, dexie } = await deps.loadFileSpace(sessionId)
  if (space.status === "deleted") return fail("This conversation no longer exists")
  const result: Record<string, unknown> = {
    ok: true,
    status: space.status,
    host: { id: space.hostId, ...(space.hostLabel ? { label: space.hostLabel } : {}) },
    mounts: space.mounts.map((mount) => ({
      path: mount.virtualPath,
      label: mount.label,
      kind: mount.backing === "disk" ? "folder" : mount.id,
      status: mount.status,
      ...(mount.statusReason ? { reason: mount.statusReason } : {}),
      writable: mount.writable,
      ...(mount.managed ? { managed: true } : {}),
    })),
  }

  if (typeof args.path === "string" && args.path.trim() !== "") {
    const listed = await listEntries(space, dexie, args.path, deps)
    if (isError(listed)) return listed
    result.entries = listed
  }

  const links = await deps.listShareLinks(sessionId)
  const now = deps.now()
  // Codes and titles only: a link's URL carries its decryption key.
  result.shares = links
    .filter((link) => link.expiresAt === undefined || link.expiresAt > now)
    .map((link) => ({
      code: link.code,
      ...(link.title ? { title: link.title } : {}),
      createdAt: link.createdAt,
      ...(link.expiresAt !== undefined ? { expiresAt: link.expiresAt } : {}),
      files: link.files?.length ?? 0,
    }))

  try {
    const grants = await deps.listLiveGrants(sessionId, space.hostId)
    result.liveAccess = grants.map(describeGrant)
  } catch (error) {
    result.liveAccess = { unavailable: deps.describeError(error).code }
  }
  return result
}

async function listEntries(
  space: ConversationFileSpace,
  dexie: LoadedConversationFileSpace["dexie"],
  rawPath: string,
  deps: FilespaceToolDeps
): Promise<unknown> {
  const path = normalizeFileSpacePath(rawPath)
  const located = path ? locateFileSpacePath(space, path) : null
  if (!path || !located) return fail(`${rawPath} is not a path in this conversation's files`)
  const { mount, relPath } = located
  let withheldSensitive = 0
  const items: { path: string; name: string; type: "folder" | "file"; size?: number }[] = []
  let truncated = false

  if (mount.backing === "dexie") {
    if (relPath !== "") return fail(`${path} is a file, not a folder`)
    const rows = mount.id === "uploads" ? dexie.uploads : dexie.artifacts
    for (const row of rows) {
      if (!row.sourceAvailable) continue
      if (isSensitivePath(row.path)) {
        withheldSensitive++
        continue
      }
      if (items.length >= MAX_LISTED_ENTRIES) {
        truncated = true
        break
      }
      items.push({ path: row.path, name: row.name, type: "file", size: row.size })
    }
  } else {
    if (mount.status !== "available" || !mount.hostPath) {
      return fail(`${mount.virtualPath} is not available right now (${mount.status})`)
    }
    const children = await deps.listDir(mount.hostPath, relPath || undefined)
    for (const child of children) {
      if (isSensitivePath(child.relPath)) {
        withheldSensitive++
        continue
      }
      if (items.length >= MAX_LISTED_ENTRIES) {
        truncated = true
        break
      }
      items.push({
        path: `${mount.virtualPath}/${child.relPath}`,
        name: child.relPath.slice(child.relPath.lastIndexOf("/") + 1),
        type: child.isDir ? "folder" : "file",
        ...(child.isDir ? {} : { size: child.size }),
      })
    }
  }
  return {
    path,
    items,
    ...(truncated ? { truncated: true } : {}),
    ...(withheldSensitive > 0 ? { withheldSensitive } : {}),
  }
}

function describeGrant(view: LiveGrantView) {
  const { grant, credentials } = view
  return {
    grantId: grant.id,
    ...(grant.label ? { label: grant.label } : {}),
    status: grant.status,
    ...(grant.statusReason ? { reason: grant.statusReason } : {}),
    provider: grant.provider,
    protocols: grant.protocols,
    permissions: grant.permissions,
    paths: grant.paths.map((path) => path.virtualPath),
    expiresAt: grant.expiresAt,
    createdBy: grant.createdBy,
    audience:
      grant.audience.kind === "collab"
        ? {
            kind: "members",
            minRole: grant.audience.minRole,
            ...(grant.audience.userIds ? { chosenMembers: grant.audience.userIds.length } : {}),
          }
        : { kind: "credentials" },
    usernames: credentials
      .filter((credential) => credential.revokedAt === null)
      .map((credential) => ({ protocol: credential.protocol, username: credential.username })),
  }
}

// ── filespace_share / filespace_enable_webdav ──────────────────────────────

/** Re-checked per call: the policy can change after the manifest was built. */
async function requireAgentSharing(
  deps: FilespaceToolDeps
): Promise<EffectiveFileSharingPolicy | ToolError> {
  const effective = await deps.loadPolicy()
  if (!effective.policy.allowAgentSharing) {
    return fail("Agents may not share files under the file-sharing policy", "policy_agent_disabled")
  }
  return effective
}

function readPaths(space: ConversationFileSpace, raw: unknown): FileSpacePath[] | ToolError {
  if (!Array.isArray(raw) || raw.length === 0) return fail("paths must list at least one path")
  if (raw.length > MAX_SHARE_PATHS) return fail(`paths may list at most ${MAX_SHARE_PATHS} paths`)
  const paths: FileSpacePath[] = []
  for (const item of raw) {
    const path = typeof item === "string" ? normalizeFileSpacePath(item) : null
    if (!path || !locateFileSpacePath(space, path)) {
      return fail(`${String(item)} is not a path in this conversation's files`)
    }
    if (!paths.includes(path)) paths.push(path)
  }
  return paths
}

function readTtl(raw: unknown, fallback: number, ceiling: number): number | ToolError {
  if (raw === undefined) return Math.min(fallback, ceiling)
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 3600) {
    return fail("expires_in_seconds must be a whole number of seconds, at least 3600")
  }
  if (raw > ceiling) {
    return fail(
      `expires_in_seconds may be at most ${ceiling} under the file-sharing policy`,
      "ttl_exceeds_policy"
    )
  }
  return raw
}

function readLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const label = raw.trim().slice(0, MAX_LABEL_CHARS)
  return label === "" ? undefined : label
}

async function loadShareable(
  deps: FilespaceToolDeps,
  sessionId: string
): Promise<{ session: ChatSession; loaded: LoadedConversationFileSpace } | ToolError> {
  const session = await deps.getSession(sessionId)
  if (!session) return fail("This conversation no longer exists")
  if (session.archivedAt != null) {
    return fail(
      "This conversation is archived; restore it before sharing its files",
      "session_inactive"
    )
  }
  const loaded = await deps.loadFileSpace(sessionId)
  if (loaded.space.status === "deleted") return fail("This conversation no longer exists")
  return { session, loaded }
}

async function runShare(
  args: Record<string, unknown>,
  deps: FilespaceToolDeps,
  sessionId: string
): Promise<unknown> {
  const effective = await requireAgentSharing(deps)
  if (isError(effective)) return effective
  const mode = args.mode
  if (mode !== "snapshot" && mode !== "live") return fail("mode must be snapshot or live")
  const shareable = await loadShareable(deps, sessionId)
  if (isError(shareable)) return shareable
  const paths = readPaths(shareable.loaded.space, args.paths)
  if (isError(paths)) return paths
  if (mode === "snapshot") return shareSnapshot(args, deps, effective, shareable, paths)

  const permissions = readPermissions(args.permissions)
  if (isError(permissions)) return permissions
  const audience = args.audience === undefined ? "credentials" : args.audience
  if (audience !== "credentials" && audience !== "members") {
    return fail("audience must be credentials or members")
  }
  if (audience === "members") {
    if (!shareable.session.collaboration) {
      return fail(
        "Only a shared conversation has members; share it with them first or use audience=credentials",
        "collab_host_unregistered"
      )
    }
    if (args.protocols !== undefined || args.provider !== undefined) {
      return fail("protocols and provider apply only to audience=credentials")
    }
    const minRole = args.min_role === undefined ? "viewer" : args.min_role
    if (!isSessionRole(minRole)) return fail("min_role must be viewer, member, maintainer or owner")
    return shareWithMembers(deps, effective, shareable.loaded.space, {
      paths,
      permissions,
      minRole,
      rawTtl: args.expires_in_seconds,
      label: readLabel(args.label),
    })
  }
  if (args.min_role !== undefined) return fail("min_role applies only to audience=members")
  const provider = args.provider === undefined ? "builtin" : args.provider
  if (provider !== "builtin" && provider !== "sftpgo")
    return fail("provider must be builtin or sftpgo")
  const protocols = readProtocols(args.protocols, provider)
  if (isError(protocols)) return protocols
  return shareLive(deps, effective, shareable.loaded.space, {
    paths,
    permissions,
    protocols,
    provider,
    rawTtl: args.expires_in_seconds,
    label: readLabel(args.label),
  })
}

async function runEnableWebdav(
  args: Record<string, unknown>,
  deps: FilespaceToolDeps,
  sessionId: string
): Promise<unknown> {
  const effective = await requireAgentSharing(deps)
  if (isError(effective)) return effective
  const shareable = await loadShareable(deps, sessionId)
  if (isError(shareable)) return shareable
  const { space } = shareable.loaded
  let paths: FileSpacePath[] | ToolError
  if (args.paths === undefined) {
    const workspace = space.mounts.find((mount) => mount.id === "workspace")
    if (!workspace) {
      return fail("This conversation has no /workspace; name the paths to share")
    }
    paths = [workspace.virtualPath as FileSpacePath]
  } else {
    paths = readPaths(space, args.paths)
  }
  if (isError(paths)) return paths
  if (args.write !== undefined && typeof args.write !== "boolean")
    return fail("write must be a boolean")
  return shareLive(deps, effective, space, {
    paths,
    permissions: ["read", "download", ...(args.write === true ? (["write"] as const) : [])],
    protocols: ["webdav"],
    provider: "builtin",
    rawTtl: args.expires_in_seconds,
    label: readLabel(args.label),
  })
}

function readPermissions(raw: unknown): LivePermission[] | ToolError {
  if (raw === undefined) return ["read", "download"]
  if (!Array.isArray(raw)) return fail("permissions must be a list")
  const chosen = new Set<LivePermission>(["read"])
  for (const item of raw) {
    if (item !== "read" && item !== "download" && item !== "write") {
      return fail("permissions may hold read, download and write")
    }
    chosen.add(item)
  }
  return (["read", "download", "write"] as const).filter((permission) => chosen.has(permission))
}

function readProtocols(raw: unknown, provider: LiveProvider): LiveProtocol[] | ToolError {
  // SFTPGo's WebDAV answers a hidden file's size and date before refusing it,
  // so a share it serves starts as SFTP only, as the dialog does.
  if (raw === undefined) return provider === "sftpgo" ? ["sftp"] : ["webdav"]
  if (!Array.isArray(raw) || raw.length === 0) return fail("protocols must list webdav or sftp")
  const chosen: LiveProtocol[] = []
  for (const item of raw) {
    if (item !== "webdav" && item !== "sftp") return fail("protocols may hold webdav and sftp")
    if (!chosen.includes(item)) chosen.push(item)
  }
  return chosen
}

async function shareSnapshot(
  args: Record<string, unknown>,
  deps: FilespaceToolDeps,
  effective: EffectiveFileSharingPolicy,
  shareable: { session: ChatSession; loaded: LoadedConversationFileSpace },
  paths: FileSpacePath[]
): Promise<unknown> {
  if (!effective.policy.allowPublicSnapshots) {
    return fail(
      "Share links with files are turned off by the file-sharing policy",
      "public-snapshots-disabled"
    )
  }
  const ttl = readTtl(
    args.expires_in_seconds,
    DEFAULT_SNAPSHOT_TTL_SECONDS,
    effective.policy.maxSnapshotTtlSeconds
  )
  if (isError(ttl)) return ttl
  const expanded = await deps.expandSelection(shareable.loaded.space, paths)
  if (expanded.truncated) {
    return fail("The selection holds more files than one link may carry; pick fewer paths")
  }
  // The sensitive floor has no agent override: those files stay out.
  const withheld = expanded.files.filter((file) => file.sensitive).map((file) => file.path)
  const files = expanded.files.filter((file) => !file.sensitive)
  if (files.length === 0) {
    return fail(
      withheld.length > 0 || expanded.skippedSensitive > 0
        ? "Every chosen file holds secrets, which an agent may not share"
        : "The chosen paths hold no files that can be shared",
      "nothing-to-share"
    )
  }
  const violations = checkShareSelectionLimits(files)
  if (violations.length > 0) return fail(describeLimits(violations), "selection-too-large")

  const created = await deps.createSnapshotShare({
    payload: fileBundlePayload(await deps.bundleTitle(shareable.session.title)),
    ttlSeconds: ttl,
    burnAfterRead: false,
    session: shareable.session,
    files,
    confirmedSensitive: new Set(),
  })
  return {
    ok: true,
    mode: "snapshot",
    code: created.code,
    url: created.url,
    ...(created.expiresAt !== undefined ? { expiresAt: created.expiresAt } : {}),
    files: files.length,
    ...(withheld.length + expanded.skippedSensitive > 0
      ? { withheldSensitive: withheld.length + expanded.skippedSensitive }
      : {}),
    ...(expanded.issues.length > 0
      ? { skipped: expanded.issues.map((issue) => ({ path: issue.path, reason: issue.reason })) }
      : {}),
  }
}

function describeLimits(violations: ShareSelectionLimitViolation[]): string {
  return violations
    .map((violation) => {
      switch (violation.kind) {
        case "too-many-files":
          return `${violation.count} files is more than the ${violation.max} one link may carry`
        case "file-too-large":
          return `${violation.path} is larger than the ${violation.max} bytes one file may be`
        case "total-too-large":
          return `the files total more than the ${violation.max} bytes one link may carry`
      }
    })
    .join("; ")
}

/**
 * A chosen path the floor refuses: as a file, or — since a share may name a
 * folder — as a directory (`/workspace/.ssh`).
 */
function refusedByFloor(path: string): boolean {
  if (isSensitivePath(path)) return true
  const segments = path.split("/").filter((segment) => segment.length > 0)
  const name = segments.pop()
  return name !== undefined && isSensitiveDirectory(segments.at(-1), name)
}

async function shareLive(
  deps: FilespaceToolDeps,
  effective: EffectiveFileSharingPolicy,
  space: ConversationFileSpace,
  terms: {
    paths: FileSpacePath[]
    permissions: LivePermission[]
    protocols: LiveProtocol[]
    provider: LiveProvider
    rawTtl: unknown
    label: string | undefined
  }
): Promise<unknown> {
  const sensitive = terms.paths.filter(refusedByFloor)
  if (sensitive.length > 0) {
    return fail(
      `${sensitive.join(", ")} holds secrets, which an agent may not share`,
      "sensitive_path"
    )
  }
  const ttl = readTtl(terms.rawTtl, DEFAULT_LIVE_TTL_SECONDS, effective.policy.maxLiveTtlSeconds)
  if (isError(ttl)) return ttl
  const created = await deps.createLiveShare(
    {
      sessionId: space.sessionId,
      paths: terms.paths,
      permissions: terms.permissions,
      protocols: terms.protocols,
      provider: terms.provider,
      expiresInSeconds: ttl,
      createdBy: "agent",
      ...(terms.label ? { label: terms.label } : {}),
    },
    space.hostId
  )
  const { grant, endpoints } = created
  return {
    ok: true,
    mode: "live",
    grantId: grant.id,
    hostId: space.hostId,
    status: grant.status,
    provider: grant.provider,
    protocols: grant.protocols,
    permissions: grant.permissions,
    paths: grant.paths.map((path) => path.virtualPath),
    expiresAt: grant.expiresAt,
    // Usernames only. The password the host issued is dropped here.
    credentials: created.credentials.map(({ credential }) => ({
      credentialId: credential.id,
      protocol: credential.protocol,
      username: credential.username,
    })),
    endpoints: {
      webdavUrls: endpoints.webdavUrls,
      sftp: endpoints.sftp,
      sftpHostKeyFingerprint: endpoints.sftpHostKeyFingerprint,
      tlsFingerprint: endpoints.tlsFingerprint,
      ...(endpoints.unavailableReason ? { unavailableReason: endpoints.unavailableReason } : {}),
    },
    password:
      "Not given to the agent. The user issues one from this result's card, or from Files → Shared as network drive.",
  }
}

function isSessionRole(value: unknown): value is SessionRole {
  return value === "viewer" || value === "member" || value === "maintainer" || value === "owner"
}

/**
 * A live share for the shared conversation's members: no credentials, so
 * nothing secret is answered either way. `createLiveShare` registers the host
 * for the conversation first when it is not.
 */
async function shareWithMembers(
  deps: FilespaceToolDeps,
  effective: EffectiveFileSharingPolicy,
  space: ConversationFileSpace,
  terms: {
    paths: FileSpacePath[]
    permissions: LivePermission[]
    minRole: SessionRole
    rawTtl: unknown
    label: string | undefined
  }
): Promise<unknown> {
  const sensitive = terms.paths.filter(refusedByFloor)
  if (sensitive.length > 0) {
    return fail(
      `${sensitive.join(", ")} holds secrets, which an agent may not share`,
      "sensitive_path"
    )
  }
  const ttl = readTtl(terms.rawTtl, DEFAULT_LIVE_TTL_SECONDS, effective.policy.maxLiveTtlSeconds)
  if (isError(ttl)) return ttl
  const { grant } = await deps.createLiveShare(
    {
      sessionId: space.sessionId,
      paths: terms.paths,
      permissions: terms.permissions,
      protocols: [],
      expiresInSeconds: ttl,
      createdBy: "agent",
      audience: { kind: "collab", minRole: terms.minRole },
      ...(terms.label ? { label: terms.label } : {}),
    },
    space.hostId
  )
  return {
    ok: true,
    mode: "live",
    audience: "members",
    grantId: grant.id,
    hostId: space.hostId,
    status: grant.status,
    minRole: terms.minRole,
    permissions: grant.permissions,
    paths: grant.paths.map((path) => path.virtualPath),
    expiresAt: grant.expiresAt,
  }
}

// ── filespace_revoke_share / filespace_disable_webdav ──────────────────────

async function runRevoke(
  args: Record<string, unknown>,
  deps: FilespaceToolDeps,
  sessionId: string
): Promise<unknown> {
  const code = typeof args.code === "string" ? args.code.trim() : ""
  const grantId = typeof args.grant_id === "string" ? args.grant_id.trim() : ""
  if ((code === "") === (grantId === "")) return fail("Give exactly one of code or grant_id")

  if (code) {
    const links = await deps.listShareLinks(sessionId)
    // Only a link made from this conversation: a code from elsewhere is
    // answered like one that does not exist.
    if (!links.some((link) => link.code === code)) {
      return fail(`No working share link ${code} was made from this conversation`, "not_found")
    }
    await deps.revokeShareLink(code)
    return { ok: true, revoked: { code } }
  }

  const { space } = await deps.loadFileSpace(sessionId)
  const grants = await deps.listLiveGrants(sessionId, space.hostId)
  const view = grants.find((candidate) => candidate.grant.id === grantId)
  if (!view || view.grant.sessionId !== sessionId) {
    return fail(`No network-drive access ${grantId} belongs to this conversation`, "not_found")
  }
  if (view.grant.status === "revoked") return { ok: true, revoked: { grantId }, already: true }
  const revoked = await deps.revokeLiveGrant(grantId, space.hostId)
  return { ok: true, revoked: { grantId, status: revoked.grant.status } }
}

async function runDisableWebdav(deps: FilespaceToolDeps, sessionId: string): Promise<unknown> {
  const { space } = await deps.loadFileSpace(sessionId)
  const grants = await deps.listLiveGrants(sessionId, space.hostId)
  const targets = grants.filter(
    ({ grant }) =>
      grant.sessionId === sessionId &&
      grant.protocols.includes("webdav") &&
      grant.status !== "revoked" &&
      grant.status !== "expired"
  )
  const revoked: string[] = []
  const failed: { grantId: string; code: string }[] = []
  for (const { grant } of targets) {
    try {
      await deps.revokeLiveGrant(grant.id, space.hostId)
      revoked.push(grant.id)
    } catch (error) {
      failed.push({ grantId: grant.id, code: deps.describeError(error).code })
    }
  }
  // Revoking a grant ends every protocol it speaks: name the SFTP ones too.
  const alsoSftp = targets
    .filter(({ grant }) => grant.protocols.includes("sftp") && revoked.includes(grant.id))
    .map(({ grant }) => grant.id)
  return {
    ok: failed.length === 0,
    revoked,
    ...(alsoSftp.length > 0 ? { alsoEndedSftp: alsoSftp } : {}),
    ...(failed.length > 0 ? { failed, error: "Some access could not be revoked" } : {}),
  }
}

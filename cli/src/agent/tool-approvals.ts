/**
 * Persistent "Allow always" store for tool approvals, saved to
 * `~/.cognia/tool-approvals.json`.
 *
 * The desktop remembers the user's "always allow" choices in its settings store;
 * the standalone CLI had no equivalent, so picking "Allow always" only allowed
 * that single call and the same tool prompted again on its next use. This module
 * gives the CLI the same memory: when the user picks "Allow always", the tool's
 * namespaced name is recorded here and merged into `suppressApprovalForTools` on
 * every subsequent turn (and future launches), so it never prompts again.
 *
 * Each approval can carry an optional **TTL** (`expiresAt`) and **cwd scope**
 * (`cwd`) so a broad tool like `bash` isn't trusted forever, everywhere, after a
 * single "Allow always". The on-disk shape is the richer
 * `{ "approvals": [{ tool, cwd?, expiresAt? }] }`; the legacy
 * `{ "allowed": ["…"] }` form is still read for back-compat.
 *
 * Names are the gate's namespaced form (`mcp__cognia-tools__<name>`), matching
 * `lib/settings/builtin-tools.ts:namespaced()` and what the sidecar emits on a
 * `permission_request`.
 */
import nodeFs from "node:fs"
import path from "node:path"

export interface ToolApprovalsFs {
  exists(path: string): boolean
  readText(path: string): string
  writeText(path: string, data: string): void
}

/** One persisted approval, optionally scoped to a cwd and/or an expiry. */
export interface ToolApprovalEntry {
  tool: string
  /** When set, the approval only applies while running in this directory. */
  cwd?: string
  /** Epoch-ms expiry; the approval is ignored once `Date.now()` passes it. */
  expiresAt?: number
}

const defaultFs: ToolApprovalsFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
  writeText: (p, data) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    nodeFs.writeFileSync(p, data, "utf8")
  },
}

export function toolApprovalsPath(home: string): string {
  return path.join(home, "tool-approvals.json")
}

/** All persisted approval entries (raw — includes expired / other-cwd). */
export function readToolApprovalEntries(
  home: string,
  fs: ToolApprovalsFs = defaultFs
): ToolApprovalEntry[] {
  const file = toolApprovalsPath(home)
  if (!fs.exists(file)) return []
  try {
    const parsed = JSON.parse(fs.readText(file)) as {
      approvals?: unknown
      allowed?: unknown
    }
    const out: ToolApprovalEntry[] = []
    if (Array.isArray(parsed.approvals)) {
      for (const e of parsed.approvals) {
        if (e && typeof e === "object" && typeof (e as ToolApprovalEntry).tool === "string") {
          const { tool, cwd, expiresAt } = e as ToolApprovalEntry
          out.push({
            tool,
            ...(typeof cwd === "string" ? { cwd } : {}),
            ...(typeof expiresAt === "number" ? { expiresAt } : {}),
          })
        }
      }
    }
    // Legacy back-compat: a bare `allowed: string[]` becomes unscoped entries.
    if (Array.isArray(parsed.allowed)) {
      for (const n of parsed.allowed) {
        if (typeof n === "string" && !out.some((e) => e.tool === n)) out.push({ tool: n })
      }
    }
    return out
  } catch {
    return []
  }
}

function isLive(entry: ToolApprovalEntry, now: number, cwd?: string): boolean {
  if (typeof entry.expiresAt === "number" && now >= entry.expiresAt) return false
  // A cwd-scoped entry only applies in its directory; unscoped entries are global.
  if (entry.cwd !== undefined && cwd !== undefined && entry.cwd !== cwd) return false
  return true
}

/**
 * The set of tools effectively always-allowed right now: expired entries are
 * dropped, and (when `cwd` is supplied) cwd-scoped entries that don't match are
 * dropped too. Returns the gate's namespaced names so it can union straight into
 * `suppressApprovalForTools`. Signature stays back-compatible — existing callers
 * pass `(home)` / `(home, fs)` and get TTL filtering for free.
 */
export function readToolApprovals(
  home: string,
  fs: ToolApprovalsFs = defaultFs,
  cwd?: string
): Set<string> {
  const now = Date.now()
  const live = readToolApprovalEntries(home, fs).filter((e) => isLive(e, now, cwd))
  return new Set(live.map((e) => e.tool))
}

function writeEntries(home: string, entries: ToolApprovalEntry[], fs: ToolApprovalsFs): void {
  fs.writeText(toolApprovalsPath(home), JSON.stringify({ approvals: entries }, null, 2))
}

/**
 * Record a tool as always-allowed and persist. `opts.cwd` scopes it to a
 * directory; `opts.ttlMs` expires it after a duration. Re-adding a tool replaces
 * its prior entry (so the newest scope/TTL wins). Returns the live name set.
 */
export function addToolApproval(
  home: string,
  toolName: string,
  fs: ToolApprovalsFs = defaultFs,
  opts: { cwd?: string; ttlMs?: number } = {}
): Set<string> {
  const entries = readToolApprovalEntries(home, fs).filter((e) => e.tool !== toolName)
  entries.push({
    tool: toolName,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(typeof opts.ttlMs === "number" ? { expiresAt: Date.now() + opts.ttlMs } : {}),
  })
  writeEntries(home, entries, fs)
  return readToolApprovals(home, fs, opts.cwd)
}

/**
 * Forget a single tool's approval. Returns true when an entry was removed.
 */
export function removeToolApproval(
  home: string,
  toolName: string,
  fs: ToolApprovalsFs = defaultFs
): boolean {
  const entries = readToolApprovalEntries(home, fs)
  const next = entries.filter((e) => e.tool !== toolName)
  if (next.length === entries.length) return false
  writeEntries(home, next, fs)
  return true
}

/**
 * Forget every persisted "Allow always" choice (writes an empty list). Returns
 * how many were cleared so the caller can report it. The next turn re-resolves
 * options, so the cleared tools start prompting again.
 */
export function clearToolApprovals(home: string, fs: ToolApprovalsFs = defaultFs): number {
  const count = readToolApprovalEntries(home, fs).length
  writeEntries(home, [], fs)
  return count
}

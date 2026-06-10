/**
 * Persistent "Allow always" store for tool approvals, saved to
 * `~/.cognia/tool-approvals.json` as `{ "allowed": ["mcp__cognia-tools__bash", …] }`.
 *
 * The desktop remembers the user's "always allow" choices in its settings store;
 * the standalone CLI had no equivalent, so picking "Allow always" only allowed
 * that single call and the same tool prompted again on its next use. This module
 * gives the CLI the same memory: when the user picks "Allow always", the tool's
 * namespaced name is recorded here and merged into `suppressApprovalForTools` on
 * every subsequent turn (and future launches), so it never prompts again.
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

/** The set of tools the user has chosen to always allow. Empty on missing/corrupt. */
export function readToolApprovals(home: string, fs: ToolApprovalsFs = defaultFs): Set<string> {
  const file = toolApprovalsPath(home)
  if (!fs.exists(file)) return new Set()
  try {
    const parsed = JSON.parse(fs.readText(file)) as { allowed?: unknown }
    if (Array.isArray(parsed.allowed)) {
      return new Set(parsed.allowed.filter((n): n is string => typeof n === "string"))
    }
  } catch {
    // corrupt → empty
  }
  return new Set()
}

/**
 * Record a tool as always-allowed and persist. Returns the new set. Idempotent —
 * adding an already-allowed tool is a no-op write (keeps the file canonical).
 */
export function addToolApproval(
  home: string,
  toolName: string,
  fs: ToolApprovalsFs = defaultFs
): Set<string> {
  const set = readToolApprovals(home, fs)
  set.add(toolName)
  fs.writeText(toolApprovalsPath(home), JSON.stringify({ allowed: [...set] }, null, 2))
  return set
}

/**
 * Forget every persisted "Allow always" choice (writes an empty list). Returns
 * how many were cleared so the caller can report it. The next turn re-resolves
 * options, so the cleared tools start prompting again.
 */
export function clearToolApprovals(home: string, fs: ToolApprovalsFs = defaultFs): number {
  const count = readToolApprovals(home, fs).size
  fs.writeText(toolApprovalsPath(home), JSON.stringify({ allowed: [] }, null, 2))
  return count
}

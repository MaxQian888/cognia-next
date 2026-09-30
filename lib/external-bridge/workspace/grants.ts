/**
 * Which workspace roots an External Bridge client may touch (roadmap
 * 2026-09-29, Phase 2 "credential-to-project scoping").
 *
 * A scope says WHAT a client may do (`workspace:read`, `shell:run`, …); a
 * grant says WHERE. Grants are keyed by the bridge caller id — `mcp:stdio` for
 * the stdio transport, `mcp:<clientId>` for an HTTP client credential — and
 * name project roots by their stable `WorkspaceRoot.id`, never by path, so an
 * agent can only address a root the user picked for it. No grant means no
 * roots: a client that holds a workspace scope but no grant sees nothing.
 *
 * The host's `fs_*_workspace` commands accept any absolute root from the local
 * renderer, so this resolution is the fence, not a convenience.
 */

import { getAllProjects } from "@/lib/db/projects"
import { getSettings } from "@/lib/db/settings"
import type { Project } from "@/types"
import type { ExternalBridgeSettings } from "@/types/wiki"

export { STDIO_BRIDGE_CALLER, bridgeCallerForClientId } from "../bridge-caller"

/** A root the caller may address, as the tools present it. */
export interface GrantedRoot {
  /** `WorkspaceRoot.id` — the only handle a tool accepts. */
  id: string
  /** Display label: the root's label, else the workspace name + basename. */
  label: string
  workspace: string
  /** Absolute path. Host-side only; never returned to the client. */
  path: string
}

export interface GrantDeps {
  loadSettings(): Promise<ExternalBridgeSettings | undefined>
  loadProjects(): Promise<Pick<Project, "id" | "name" | "roots">[]>
}

const defaultDeps: GrantDeps = {
  loadSettings: async () => (await getSettings()).externalBridge,
  loadProjects: getAllProjects,
}

function basename(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Every root any project mounts, labelled — the grant picker's universe. */
export function listAllRoots(projects: Pick<Project, "id" | "name" | "roots">[]): GrantedRoot[] {
  const out: GrantedRoot[] = []
  for (const project of projects) {
    for (const root of project.roots ?? []) {
      if (!root?.id || !root.path) continue
      out.push({
        id: root.id,
        label: root.label?.trim() || basename(root.path),
        workspace: project.name,
        path: root.path,
      })
    }
  }
  return out
}

/** The roots granted to `caller`, in project order. Unknown ids are dropped. */
export async function resolveGrantedRoots(
  caller: string,
  deps: GrantDeps = defaultDeps
): Promise<GrantedRoot[]> {
  const settings = await deps.loadSettings()
  const granted = new Set(settings?.workspaceGrants?.[caller] ?? [])
  if (granted.size === 0) return []
  return listAllRoots(await deps.loadProjects()).filter((root) => granted.has(root.id))
}

/** Result of resolving a tool's `root` + `path` arguments. */
export type ResolvedTarget =
  | { ok: true; root: GrantedRoot; relPath: string }
  | { ok: false; code: "root_not_granted" | "invalid_path"; error: string }

/**
 * Normalize a root-relative path. Refuses (never repairs) an absolute path, a
 * drive or UNC prefix, a `..` segment or a NUL byte: those are identity
 * inputs, and a silently rewritten path is a different file.
 */
export function normalizeRelPath(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return ""
  if (typeof raw !== "string") return null
  if (raw.includes("\0")) return null
  const unified = raw.replaceAll("\\", "/")
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null
  const segments = unified.split("/").filter((segment) => segment.length > 0 && segment !== ".")
  if (segments.some((segment) => segment === "..")) return null
  return segments.join("/")
}

export async function resolveTarget(
  caller: string,
  rootId: unknown,
  path: unknown,
  deps: GrantDeps = defaultDeps
): Promise<ResolvedTarget> {
  const roots = await resolveGrantedRoots(caller, deps)
  const root = typeof rootId === "string" ? roots.find((r) => r.id === rootId) : undefined
  if (!root) {
    return {
      ok: false,
      code: "root_not_granted",
      error:
        roots.length === 0
          ? "no workspace roots are granted to this client — grant one in Settings → External Bridge → Workspace access"
          : `root '${String(rootId)}' is not granted to this client; call workspace_roots for the granted ids`,
    }
  }
  const relPath = normalizeRelPath(path)
  if (relPath === null) {
    return {
      ok: false,
      code: "invalid_path",
      error: "path must be relative to the root, without '..' segments",
    }
  }
  return { ok: true, root, relPath }
}

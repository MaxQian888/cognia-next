/**
 * Do the paths and scripts an instruction names still exist (ADR-0238 §4)?
 *
 * The prompt-audit method's "volatile specifics" check: a rule that points at
 * a file or a `pnpm` script the repository no longer has is a high-confidence
 * stale fact. The host answers it under the method's own limits:
 *
 * - only paths inside the workspace's roots are probed; anything else, a
 *   network path included, is `outside`;
 * - a symbolic link, at the path or on the way to it, is reported, never
 *   followed;
 * - scripts are looked up in the roots' `package.json`, never run.
 */

import { statWorkspaceFile, readWorkspaceFile } from "@/lib/files/workspace-fs"
import { isTauri } from "@/lib/tauri"
import type {
  AgentConfigPathStatus,
  AgentConfigReferenceCheck,
  AgentConfigReferenceInput,
} from "./types"
import { resolveAgentConfigWorkspace } from "./workspace"

/** Hard cap so a pathological instruction file cannot fan out into thousands of probes. */
export const MAX_REFERENCE_PATHS = 200
export const MAX_REFERENCE_SCRIPTS = 100

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * The root a path lives under and its segments relative to that root, or
 * `undefined` when it is outside every root or climbs out with `..`.
 */
export function locateInRoots(
  path: string,
  roots: readonly string[]
): { root: string; segments: string[] } | undefined {
  const raw = path.trim()
  if (!raw || SCHEME.test(raw) || raw.startsWith("~") || raw.startsWith("//")) return undefined
  const value = normalize(raw)
  const absolute = value.startsWith("/") || WINDOWS_ABSOLUTE.test(value)
  let root: string | undefined
  let rest: string
  if (absolute) {
    root = roots.find((candidate) => {
      const base = normalize(candidate)
      return value === base || value.startsWith(`${base}/`)
    })
    if (!root) return undefined
    rest = value.slice(normalize(root).length).replace(/^\/+/, "")
  } else {
    root = roots[0]
    if (!root) return undefined
    rest = value.replace(/^\.\//, "")
  }
  const segments = rest.split("/").filter((segment) => segment.length > 0 && segment !== ".")
  if (segments.some((segment) => segment === "..")) return undefined
  return { root, segments }
}

export interface AgentConfigReferenceDeps {
  stat?: typeof statWorkspaceFile
  read?: typeof readWorkspaceFile
  isDesktop?: () => boolean
}

async function checkPath(
  path: string,
  roots: readonly string[],
  stat: typeof statWorkspaceFile
): Promise<AgentConfigPathStatus> {
  const located = locateInRoots(path, roots)
  if (!located) return "outside"
  if (located.segments.length === 0) return "exists"
  try {
    for (let depth = 1; depth <= located.segments.length; depth++) {
      const relPath = located.segments.slice(0, depth).join("/")
      const info = await stat(located.root, relPath)
      if (!info.exists) return "missing"
      if (info.isSymlink) return "symlink"
    }
    return "exists"
  } catch {
    return "unchecked"
  }
}

async function definedScripts(
  roots: readonly string[],
  read: typeof readWorkspaceFile
): Promise<Set<string> | undefined> {
  const names = new Set<string>()
  let readAny = false
  for (const root of roots) {
    try {
      const manifest = JSON.parse(await read(root, "package.json", 512_000)) as {
        scripts?: Record<string, unknown>
      }
      readAny = true
      for (const name of Object.keys(manifest.scripts ?? {})) names.add(name)
    } catch {
      // No (readable) package.json at this root.
    }
  }
  return readAny ? names : undefined
}

export async function checkAgentConfigReferences(
  input: AgentConfigReferenceInput,
  deps: AgentConfigReferenceDeps = {}
): Promise<AgentConfigReferenceCheck> {
  const workspace = resolveAgentConfigWorkspace(input.workspaceId)
  const paths = [...new Set(input.paths ?? [])].slice(0, MAX_REFERENCE_PATHS)
  const scripts = [...new Set(input.scripts ?? [])].slice(0, MAX_REFERENCE_SCRIPTS)
  const desktop = (deps.isDesktop ?? isTauri)()
  if (!desktop || workspace.roots.length === 0) {
    return {
      paths: paths.map((path) => ({
        path,
        status: locateInRoots(path, workspace.roots) ? "unchecked" : "outside",
      })),
      scripts: scripts.map((name) => ({ name, status: "unchecked" })),
    }
  }
  const stat = deps.stat ?? statWorkspaceFile
  const read = deps.read ?? readWorkspaceFile
  const pathResults = await Promise.all(
    paths.map(async (path) => ({ path, status: await checkPath(path, workspace.roots, stat) }))
  )
  const defined = scripts.length > 0 ? await definedScripts(workspace.roots, read) : undefined
  return {
    paths: pathResults,
    scripts: scripts.map((name) => ({
      name,
      status: !defined ? "unchecked" : defined.has(name) ? "defined" : "undefined",
    })),
  }
}

/**
 * ADR-0028 — pure sandbox resource/network ceiling helpers.
 *
 * Runtime placement state, including the resolved policy, lives in the
 * immutable `SandboxRuntimeRef`. This module only owns monotonic clamping and
 * path-boundary helpers shared by that runtime and external-agent paths.
 */

import type { SandboxResourcePolicy } from "@cognia/agent-config-types"
import { isPathWithinRoot, normalizeFsPath } from "@/lib/files/permissions"

/** The clampable subset of the plugin's `PolicyRequest` (network + caps). */
export interface ClampableRequest {
  maxCpuSeconds: number
  maxMemoryMb: number
  network: "off" | "on" | "allowlist"
  networkHosts: string[]
  /** Writable directories — narrowed to `policy.writableRoots` when set. */
  writable?: string[]
  /** Read requests are narrowed against the policy, runtime roots and cwd. */
  readable?: string[]
  /** The actual command working directory, supplied by the tool adapter. */
  cwd?: string
  /** Host-stamped read ceiling for native canonicalization; never caller authority. */
  readableRoots?: string[]
  /** Single-file write targets (Edit/Write/TextEditor) — narrowed too. */
  targetFiles?: string[]
}

/**
 * True when `p` is, or is nested under, `root`. String-prefix with a path
 * separator boundary after lexical normalization of `.` / `..`, separators
 * and trailing slashes.
 * Windows comparisons are case-insensitive to match the backend floor; POSIX
 * comparisons stay case-sensitive. This is the configurable *narrowing* check
 * — the Rust floor canonicalizes for the real (symlink-resolved) boundary.
 */
export function isPathUnderRoot(
  p: string,
  root: string,
  platform: NodeJS.Platform | string = typeof process === "undefined" ? "" : process.platform
): boolean {
  if (!p || !root) return false
  const normalizeCase = (s: string) => (platform === "win32" ? s.toLocaleLowerCase("en-US") : s)
  const np = normalizeFsPath(p)
  const nr = normalizeFsPath(root)
  if (!np || !nr) return false
  return isPathWithinRoot(normalizeCase(np), normalizeCase(nr))
}

/** Intersection of directory scopes, including an ancestor request narrowed to a root. */
export function intersectPathRoots(paths: string[], roots: string[]): string[] {
  return Array.from(
    new Set(
      paths.flatMap((path) =>
        roots.flatMap((root) =>
          isPathUnderRoot(path, root)
            ? [normalizeFsPath(path)]
            : isPathUnderRoot(root, path)
              ? [normalizeFsPath(root)]
              : []
        )
      )
    )
  )
}

function narrowRequiredReadScope(paths: string[], roots: string[]): string[] {
  return Array.from(
    new Set(
      paths.flatMap((path) => {
        const narrowed = intersectPathRoots([path], roots)
        if (narrowed.length === 0) {
          throw new Error(
            `sandbox: readable path ${JSON.stringify(path)} is outside the configured readable roots; ` +
              "add an allowed directory in Settings → Sandbox readable roots."
          )
        }
        return narrowed
      })
    )
  )
}

/** Keep only the paths that sit under one of `roots`. */
function narrowToRoots(paths: string[] | undefined, roots: string[]): string[] {
  if (!paths || paths.length === 0) return []
  return paths.filter((p) => roots.some((r) => isPathUnderRoot(p, r)))
}

export function narrowRequiredWriteScope(
  paths: string[] | undefined,
  roots: string[],
  label: string
): string[] | undefined {
  if (paths === undefined) return undefined
  const narrowed = narrowToRoots(paths, roots)
  if (paths.length > 0 && narrowed.length === 0) {
    throw new Error(
      `sandbox: ${label} outside the configured writable roots; choose a path under ` +
        roots.join(", ")
    )
  }
  return narrowed
}

/** Clamp a single numeric cap to its ceiling. `0` from the model means
 *  "backend default" — when a ceiling exists, the ceiling becomes the value. */
function clampCap(requested: number, ceiling: number | undefined): number {
  if (!ceiling || ceiling <= 0) return requested
  if (requested <= 0) return ceiling
  return Math.min(requested, ceiling)
}

/** Apply the network ceiling. The model can only ever narrow, never widen. */
function clampNetwork(
  reqNetwork: "off" | "on" | "allowlist",
  reqHosts: string[],
  policy: SandboxResourcePolicy
): { network: "off" | "on" | "allowlist"; networkHosts: string[] } {
  // The model already chose the most-restrictive option — keep it.
  if (reqNetwork === "off") return { network: "off", networkHosts: [] }

  const ceiling = policy.network ?? "on"
  if (ceiling === "off") return { network: "off", networkHosts: [] }
  if (ceiling === "on") return { network: reqNetwork, networkHosts: reqHosts }

  // ceiling === "allowlist": cap egress to the configured hosts.
  const allowed = policy.networkAllowlist ?? []
  if (allowed.length === 0) return { network: "off", networkHosts: [] }
  if (reqNetwork === "allowlist") {
    const intersection = reqHosts.filter((h) => allowed.includes(h))
    return intersection.length > 0
      ? { network: "allowlist", networkHosts: intersection }
      : { network: "off", networkHosts: [] }
  }
  // reqNetwork === "on" → cap to the configured allowlist.
  return { network: "allowlist", networkHosts: allowed }
}

/**
 * Clamp a model-supplied read request down to the configured read ceiling.
 *
 * A ceiling exists only when one is configured: `policy.readableRoots` /
 * `policy.writableRoots`, or the session's frozen confinement roots
 * (`ceilingRoots`). Then the ceiling is those roots plus the context roots
 * (the session's workspace root) and the command cwd, and every requested
 * readable path must sit under it (an ancestor is narrowed to the roots
 * beneath it; anything else is refused). With no configured ceiling the
 * readable set passes through unchanged, as before: a workspace root or cwd
 * alone never creates one, and the native floor still hides secrets.
 */
export function clampReadableRequest<
  T extends Pick<ClampableRequest, "readable" | "cwd" | "readableRoots">,
>(
  request: T,
  policy: SandboxResourcePolicy | null,
  ceilingRoots: string[] = [],
  contextRoots: string[] = []
): T {
  const configured = Array.from(
    new Set([...(policy?.readableRoots ?? []), ...(policy?.writableRoots ?? []), ...ceilingRoots])
  )
  if (configured.length === 0) {
    // Strip any caller-stamped ceiling: only the host may supply one.
    const { readableRoots: _ignored, ...rest } = request
    return rest as T
  }
  const readRoots = Array.from(
    new Set([...configured, ...contextRoots, ...(request.cwd ? [request.cwd] : [])])
  )
  return {
    ...request,
    readableRoots: readRoots,
    ...(request.readable !== undefined
      ? { readable: narrowRequiredReadScope(request.readable, readRoots) }
      : {}),
  }
}

export function clampPolicyRequest<T extends ClampableRequest>(
  request: T,
  policy: SandboxResourcePolicy | null,
  ceilingRoots: string[] = [],
  contextRoots: string[] = []
): T {
  const readableRequest = clampReadableRequest(request, policy, ceilingRoots, contextRoots)
  if (!policy) return readableRequest
  const net = clampNetwork(request.network, request.networkHosts, policy)
  // The always-on native floor still rejects forbidden roots and hides secrets.
  const roots = policy.writableRoots ?? []
  const pathPatch =
    roots.length > 0
      ? {
          ...(request.writable !== undefined
            ? {
                writable: narrowRequiredWriteScope(request.writable, roots, "writable path is"),
              }
            : {}),
          ...(request.targetFiles !== undefined
            ? {
                targetFiles: narrowRequiredWriteScope(request.targetFiles, roots, "target file is"),
              }
            : {}),
        }
      : {}
  return {
    ...readableRequest,
    ...pathPatch,
    maxCpuSeconds: clampCap(request.maxCpuSeconds, policy.maxCpuSeconds),
    maxMemoryMb: clampCap(request.maxMemoryMb, policy.maxMemoryMb),
    network: net.network,
    networkHosts: net.networkHosts,
  }
}

/**
 * Compose a parent sandbox ceiling with a child override so the child may only
 * ever **further-restrict** — the sandbox analogue of
 * `deriveExternalSessionPermission`. Used when a teammate / subagent dispatch
 * inherits its parent's sandbox ceiling: writable roots narrow to the parent's,
 * network clamps down, and resource caps take the tighter of the two.
 *
 * - No parent → the child stands (no ceiling to clamp against).
 * - No child  → the parent ceiling passes through unchanged.
 */
export function clampSandboxPolicy(
  parent: SandboxResourcePolicy | null | undefined,
  child: SandboxResourcePolicy | null | undefined
): SandboxResourcePolicy | undefined {
  if (!parent && !child) return undefined
  if (!parent) return child ?? undefined
  if (!child) return parent

  // Network: treat the child as a request clamped down to the parent ceiling.
  const net = clampNetwork(child.network ?? "on", child.networkAllowlist ?? [], parent)

  // Writable roots: narrow the child's roots to those under the parent's. An
  // unset child inherits the parent's ceiling; an unset parent imposes none.
  const parentRoots = parent.writableRoots ?? []
  let writableRoots =
    child.writableRoots !== undefined
      ? parentRoots.length > 0
        ? narrowToRoots(child.writableRoots, parentRoots)
        : child.writableRoots
      : parent.writableRoots

  const parentReadRoots = [...(parent.readableRoots ?? []), ...parentRoots]
  // Writable grants also grant reads. A child cannot evade an inherited read
  // ceiling by moving its requested directory into writableRoots instead.
  if (parentReadRoots.length > 0 && writableRoots?.length) {
    writableRoots = narrowRequiredReadScope(writableRoots, parentReadRoots)
  }
  const readableRoots = child.readableRoots?.length
    ? parentReadRoots.length > 0
      ? narrowRequiredReadScope(child.readableRoots, parentReadRoots)
      : child.readableRoots
    : parent.readableRoots?.length
      ? parent.readableRoots
      : parentReadRoots.length > 0
        ? parentReadRoots
        : parent.readableRoots

  return {
    maxCpuSeconds: clampCap(child.maxCpuSeconds ?? 0, parent.maxCpuSeconds),
    maxMemoryMb: clampCap(child.maxMemoryMb ?? 0, parent.maxMemoryMb),
    network: net.network,
    networkAllowlist:
      net.network === "allowlist"
        ? net.networkHosts
        : (child.networkAllowlist ?? parent.networkAllowlist),
    ...(writableRoots !== undefined ? { writableRoots } : {}),
    ...(readableRoots !== undefined ? { readableRoots } : {}),
  }
}

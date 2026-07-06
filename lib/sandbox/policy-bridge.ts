/**
 * ADR-0028 — per-session sandbox resource/network **ceiling** bridge.
 *
 * `lib/claude/build-options.ts:resolveSendOptions` resolves the effective
 * `SandboxResourcePolicy` (character override beats the app default) and
 * stamps it here keyed by session id, right before the send goes out — the
 * same pattern `microvm-bridge` uses for the tier. The
 * `cognia-sandboxed-tools` plugin reads it inside its `execute()` and clamps
 * the model-supplied per-call request DOWN to the ceiling before forwarding
 * to the Rust `sandbox_exec` dispatcher. Because the model can only reach the
 * sandbox through that plugin, the clamp cannot be bypassed.
 */

import type { SandboxResourcePolicy } from "@/lib/claude/types"

/** The clampable subset of the plugin's `PolicyRequest` (network + caps). */
export interface ClampableRequest {
  maxCpuSeconds: number
  maxMemoryMb: number
  network: "off" | "on" | "allowlist"
  networkHosts: string[]
  /** Writable directories — narrowed to `policy.writableRoots` when set. */
  writable?: string[]
  /** Single-file write targets (Edit/Write/TextEditor) — narrowed too. */
  targetFiles?: string[]
}

/**
 * True when `p` is, or is nested under, `root`. String-prefix with a path
 * separator boundary; tolerant of both `/` and `\\` and trailing slashes.
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
  const strip = (s: string) => s.replace(/[\\/]+$/, "")
  const normalizeCase = (s: string) => (platform === "win32" ? s.toLocaleLowerCase("en-US") : s)
  const np = normalizeCase(strip(p))
  const nr = normalizeCase(strip(root))
  if (np === nr) return true
  return np.startsWith(`${nr}/`) || np.startsWith(`${nr}\\`)
}

/** Keep only the paths that sit under one of `roots`. */
function narrowToRoots(paths: string[] | undefined, roots: string[]): string[] {
  if (!paths || paths.length === 0) return []
  return paths.filter((p) => roots.some((r) => isPathUnderRoot(p, r)))
}

function narrowRequiredWriteScope(
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

/** Active resolved policy per session id. */
const activePolicy = new Map<string, SandboxResourcePolicy>()

/**
 * Stamp the resolved sandbox policy for the next send on `sessionId`. Pass
 * `null` to clear (e.g. when the sandbox is disabled for this session) so a
 * stale ceiling can't leak into a later, un-policied call.
 */
export function setActiveSandboxPolicy(
  sessionId: string | null | undefined,
  policy: SandboxResourcePolicy | null
): void {
  if (!sessionId) return
  if (policy) {
    activePolicy.set(sessionId, policy)
  } else {
    activePolicy.delete(sessionId)
  }
}

/** Read the active policy for `sessionId`, or `null` when none is set. */
export function getActiveSandboxPolicy(
  sessionId: string | null | undefined
): SandboxResourcePolicy | null {
  if (!sessionId) return null
  return activePolicy.get(sessionId) ?? null
}

/** Clear the active policy when a session ends. */
export function clearActiveSandboxPolicy(sessionId: string): void {
  activePolicy.delete(sessionId)
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
 * Clamp a model-supplied policy request down to the configured ceiling. A
 * `null` policy (no ceiling configured) returns the request unchanged.
 */
export function clampPolicyRequest<T extends ClampableRequest>(
  request: T,
  policy: SandboxResourcePolicy | null
): T {
  if (!policy) return request
  const net = clampNetwork(request.network, request.networkHosts, policy)
  // Narrow the write surfaces to the configured ceiling. Readable is left
  // alone (it legitimately includes system dirs the toolchain needs); the
  // ceiling constrains WRITES. When no ceiling is set the paths pass through
  // unchanged and the always-on Rust floor still rejects system / app roots.
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
    ...request,
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
  const writableRoots =
    child.writableRoots !== undefined
      ? parentRoots.length > 0
        ? narrowToRoots(child.writableRoots, parentRoots)
        : child.writableRoots
      : parent.writableRoots

  return {
    maxCpuSeconds: clampCap(child.maxCpuSeconds ?? 0, parent.maxCpuSeconds),
    maxMemoryMb: clampCap(child.maxMemoryMb ?? 0, parent.maxMemoryMb),
    network: net.network,
    networkAllowlist:
      net.network === "allowlist"
        ? net.networkHosts
        : (child.networkAllowlist ?? parent.networkAllowlist),
    ...(writableRoots !== undefined ? { writableRoots } : {}),
    ...((child.readableRoots ?? parent.readableRoots)
      ? { readableRoots: child.readableRoots ?? parent.readableRoots }
      : {}),
  }
}

/** Test-only — wipe the per-session registry. */
export function __resetSandboxPolicyBridgeForTesting(): void {
  activePolicy.clear()
}

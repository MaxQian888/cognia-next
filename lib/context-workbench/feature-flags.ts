/**
 * `artifact` is intentionally absent: the chat dock has no legacy shell left to
 * roll back to (ADR-0083's one-minor window never shipped — the legacy dock and
 * the workbench were in the same unreleased batch), so a flag there could only
 * ever select a surface that no longer exists.
 */
export type ContextWorkbenchSurface = "canvas" | "project" | "workflow"

const SURFACE_FLAGS_KEY = "cognia-context-workbench-surfaces-v1"
const LEGACY_CANVAS_FLAGS_KEY = "cognia-canvas-feature-flags-v1"

// Rollback/developer flags only: production ships every surface enabled. They
// are intentionally read at mount time from env/localStorage and have no
// in-product writer or live subscription.

const DEFAULT_FLAGS: Record<ContextWorkbenchSurface, boolean> = {
  canvas: true,
  project: true,
  workflow: true,
}

function readBooleanRecord(key: string): Record<string, unknown> {
  if (typeof window === "undefined") return {}
  try {
    const value = window.localStorage.getItem(key)
    return value ? (JSON.parse(value) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function getContextWorkbenchSurfaceFlags(): Record<ContextWorkbenchSurface, boolean> {
  const stored = readBooleanRecord(SURFACE_FLAGS_KEY)
  const legacyCanvas = readBooleanRecord(LEGACY_CANVAS_FLAGS_KEY)["contextWorkbench.v1"]
  const environment = process.env.NEXT_PUBLIC_CONTEXT_WORKBENCH_V1
  const globalDefault =
    environment === "0" || environment === "false"
      ? false
      : environment === "1" || environment === "true"
        ? true
        : undefined

  return Object.fromEntries(
    (Object.keys(DEFAULT_FLAGS) as ContextWorkbenchSurface[]).map((surface) => {
      const explicit = stored[surface]
      if (typeof explicit === "boolean") return [surface, explicit]
      if (surface === "canvas" && typeof legacyCanvas === "boolean") {
        return [surface, legacyCanvas]
      }
      return [surface, globalDefault ?? DEFAULT_FLAGS[surface]]
    })
  ) as Record<ContextWorkbenchSurface, boolean>
}

export function isContextWorkbenchSurfaceEnabled(surface: ContextWorkbenchSurface): boolean {
  return getContextWorkbenchSurfaceFlags()[surface]
}

/**
 * Which hosts render their right-hand workspace on the unified Dock kernel
 * (ADR-0102) instead of the single-active-panel Context Workbench.
 *
 * Deliberately a *second* flag rather than a wider `ContextWorkbenchSurface`:
 * the two select different things. The workbench flags choose between the
 * workbench and each host's own pre-0083 sidebar — surfaces that in most cases
 * no longer exist — while these choose between the workbench and the Dock. A
 * host can therefore be on the workbench (its flag true) and off the Dock at
 * the same time, which is exactly the state every host except chat starts in.
 *
 * `chat` leads because it is the host the Dock was designed against and the one
 * with a byte-for-byte rollback path still in the tree; the rest follow one at
 * a time as each is verified. Rollback is three-tiered: per-user via
 * localStorage, per-build via `NEXT_PUBLIC_DOCK_KERNEL=0`, and in code here.
 */
export type DockKernelSurface = "chat" | "canvas" | "project" | "workflow"

const DOCK_KERNEL_FLAGS_KEY = "cognia-dock-kernel-surfaces-v1"

const DOCK_KERNEL_DEFAULTS: Record<DockKernelSurface, boolean> = {
  chat: true,
  canvas: false,
  project: false,
  workflow: false,
}

export function getDockKernelSurfaceFlags(): Record<DockKernelSurface, boolean> {
  const stored = readBooleanRecord(DOCK_KERNEL_FLAGS_KEY)
  const environment = process.env.NEXT_PUBLIC_DOCK_KERNEL

  // The kill switch is absolute in the "off" direction: a build shipped with
  // `NEXT_PUBLIC_DOCK_KERNEL=0` must not be talked back onto the Dock by a
  // localStorage key a user set weeks ago, because the reason to ship that
  // build is that the Dock is the suspect. Turning it *on* stays a default,
  // so a per-host opt-out still works there.
  if (environment === "0" || environment === "false") {
    return { chat: false, canvas: false, project: false, workflow: false }
  }
  const globalDefault = environment === "1" || environment === "true" ? true : undefined

  return Object.fromEntries(
    (Object.keys(DOCK_KERNEL_DEFAULTS) as DockKernelSurface[]).map((surface) => {
      const explicit = stored[surface]
      if (typeof explicit === "boolean") return [surface, explicit]
      return [surface, globalDefault ?? DOCK_KERNEL_DEFAULTS[surface]]
    })
  ) as Record<DockKernelSurface, boolean>
}

export function isDockKernelSurfaceEnabled(surface: DockKernelSurface): boolean {
  return getDockKernelSurfaceFlags()[surface]
}

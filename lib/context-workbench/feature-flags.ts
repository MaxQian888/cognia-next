export type ContextWorkbenchSurface = "canvas" | "project" | "artifact" | "workflow"

const SURFACE_FLAGS_KEY = "cognia-context-workbench-surfaces-v1"
const LEGACY_CANVAS_FLAGS_KEY = "cognia-canvas-feature-flags-v1"

// Rollback/developer flags only: production ships every surface enabled. They
// are intentionally read at mount time from env/localStorage and have no
// in-product writer or live subscription.

const DEFAULT_FLAGS: Record<ContextWorkbenchSurface, boolean> = {
  canvas: true,
  project: true,
  artifact: true,
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

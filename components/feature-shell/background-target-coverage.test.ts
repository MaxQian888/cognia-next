import { readFileSync, existsSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { globSync } from "node:fs"

const REPO_ROOT = resolve(__dirname, "..", "..")

/**
 * Routes that deliberately render no wallpaper, with the reason. Everything
 * here is either a paint-through native window (the wallpaper is force-disabled
 * for those in `background-applier.tsx` and again in globals.css), a chrome-less
 * full-bleed surface that owns its own backdrop, or a route with no visual
 * output at all.
 */
const EXEMPT: Record<string, string> = {
  inbox: "redirect-only route — renders nothing",
  "deep-link": "invisible handoff route, redirects immediately",
  fleet: "transparent island window — wallpaper is force-disabled there",
  island: "transparent island window — wallpaper is force-disabled there",
  onboarding: "owns a full-bleed narrative backdrop (ADR-0141)",
  pet: "transparent pet window — wallpaper is force-disabled there",
  "pet-overlay": "transparent pet window — wallpaper is force-disabled there",
  "pet-popup": "transparent pet window — wallpaper is force-disabled there",
  portal: "standalone public surface, not the app shell",
  "selection-toolbar": "transparent measuring window — wallpaper force-disabled",
  "share-target": "invisible OS share handoff route",
  status: "standalone public status page",
  "tray-panel": "transparent tray window — wallpaper is force-disabled there",
  workflows: 'marks data-bg-target="canvas" itself (its own scope)',
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

/** Resolve an import specifier to a real file under `components/` or `app/`. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(REPO_ROOT, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(fromFile), spec)
      : null
  if (!base) return null
  const rel = base.slice(REPO_ROOT.length + 1)
  if (!rel.startsWith("components/") && !rel.startsWith("app/")) return null
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    if (existsSync(base + ext)) return base + ext
  }
  return null
}

/**
 * Resolve whether a route can reach a `[data-bg-target]`: either the file marks
 * one itself, or something it imports does. Barrels re-export with relative
 * specifiers, so both `@/` and `./` forms have to be followed or a route that
 * imports through `@/components/plugins` looks unmarked when it is not.
 */
function reachesBackgroundTarget(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false
  seen.add(file)
  const src = read(file)
  if (!src) return false
  if (src.includes("data-bg-target")) return true
  // FeaturePageShell owns the marker for every route built on it.
  if (src.includes("FeaturePageShell")) return true
  if (seen.size > 400) return false

  for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
    const next = resolveSpecifier(file, m[1])
    if (next && reachesBackgroundTarget(next, seen)) return true
  }
  return false
}

describe("every route can render the wallpaper", () => {
  const routes = globSync("app/*/page.tsx", { cwd: REPO_ROOT }).sort()

  /**
   * Guard the guard. An empty walk makes the assertion below vacuously true,
   * which is exactly how a dormancy sweep rots into a no-op.
   */
  it("scans the routes it claims to scan", () => {
    expect(routes.length).toBeGreaterThanOrEqual(40)
  })

  it("leaves no route without a reachable [data-bg-target]", () => {
    const unmarked = routes
      .map((route) => ({ route, name: route.split("/")[1] }))
      .filter(({ name }) => !(name in EXEMPT))
      .filter(({ route }) => !reachesBackgroundTarget(join(REPO_ROOT, route)))
      .map(({ route }) => route)

    expect(unmarked).toEqual([])
  })

  it("keeps the exemption list honest", () => {
    const names = new Set(routes.map((r) => r.split("/")[1]))
    // A stale exemption hides a route that has since started needing coverage.
    const stale = Object.keys(EXEMPT).filter((name) => !names.has(name))
    expect(stale).toEqual([])
  })
})

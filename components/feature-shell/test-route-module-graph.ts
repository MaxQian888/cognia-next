/**
 * Walk a route's import graph, following both `@/` and relative specifiers.
 *
 * Two gates need the same walk and neither can do it with a flat grep: a route
 * usually reaches `FeaturePageShell` (and therefore the wallpaper marker, and
 * therefore the definite-height requirement) through two or three re-exports,
 * so a file that mentions neither is still built on both.
 *
 * Extracted from `background-target-coverage.test.ts`, which had the only copy,
 * so `full-viewport-coverage.test.ts` asks the same question the same way. Two
 * walkers would drift, and the whole point of these gates is that a route
 * cannot quietly fall outside them.
 */

// A build-time-only walker: nothing in the app imports it, its only callers
// are the three suites named above, and they run under Jest in node. The
// `test-` prefix tells check-unreachable-components the same thing.
// static-export-exempt: test-only walker, never reached from a bundle
import { existsSync, globSync, readFileSync } from "node:fs"
// static-export-exempt: test-only walker, never reached from a bundle
import { dirname, join, resolve } from "node:path"

export const REPO_ROOT = resolve(__dirname, "..", "..")

/**
 * Strip comments before matching.
 *
 * Documenting the very thing a gate looks for must not trip it. `me-entries.ts`
 * explains in a comment that `FeaturePageShell` collapses to a single column,
 * and that alone made `/me` look like a feature-shell route. Same reasoning
 * `scripts/gates/check-surface-usage.mjs` writes down for its own scan.
 */
function stripComments(src: string): string {
  // Line comments FIRST. A line comment can contain `/*` (a route pattern like
  // a glob, say), and stripping blocks first would read that as an opening
  // delimiter and swallow everything up to the next `*/` in the file. That is
  // not hypothetical: it silently un-marked `app/me/page.tsx`, whose comment
  // mentions a glob, the first time this ran.
  return src.replace(/(^|[^:])\/\/[^\n]*/g, "$1").replace(/\/\*[\s\S]*?\*\//g, "")
}

function read(path: string): string {
  return existsSync(path) ? stripComments(readFileSync(path, "utf8")) : ""
}

/** Resolve an import specifier to a real file under `components/` or `app/`. */
export function resolveSpecifier(fromFile: string, spec: string): string | null {
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
 * True when `file`, or anything it imports, satisfies `matches`.
 *
 * Bounded at 400 visited files: the graph reaches most of the app from any
 * route, and a gate that takes a minute per route stops being run.
 */
export function reachesSource(
  file: string,
  matches: (source: string) => boolean,
  seen = new Set<string>()
): boolean {
  if (seen.has(file)) return false
  seen.add(file)
  const src = read(file)
  if (!src) return false
  if (matches(src)) return true
  if (seen.size > 400) return false

  for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
    const next = resolveSpecifier(file, m[1]!)
    if (next && reachesSource(next, matches, seen)) return true
  }
  return false
}

/** Every top-level route page, as repo-relative paths, sorted. */
export function appRoutePages(): string[] {
  return globSync("app/*/page.tsx", { cwd: REPO_ROOT }).sort()
}

/** The route segment a page belongs to (`app/devices/page.tsx` -> `devices`). */
export function routeSegment(page: string): string {
  return page.split("/")[1]!
}

/**
 * Every route the app actually serves, as a URL path.
 *
 * Unlike `appRoutePages`, this descends into nested and grouped routes.
 * `(group)` segments exist for layout scoping and do not appear in the URL, so
 * `app/(mobile-onboard)/pair/page.tsx` is `/pair`, and a check that forgot that
 * would call the `/pair` entry stale while the route was live.
 */
export function appRouteUrls(): string[] {
  return globSync("app/**/page.tsx", { cwd: REPO_ROOT })
    .map((page) =>
      page
        .replace(/^app/, "")
        .replace(/\/page\.tsx$/, "")
        .split("/")
        .filter((part) => !(part.startsWith("(") && part.endsWith(")")))
        .join("/")
    )
    .map((url) => url || "/")
    .sort()
}

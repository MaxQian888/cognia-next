/**
 * Generate a starting `.cognia/hosting.json` for a Site.
 *
 * Pure: no filesystem, no Tauri, no clock. Callers hand in a probe of the
 * source directory (see `lib/sites/manifest-file.ts`) and get back a manifest
 * plus any companion files that must land on disk with it. This mirrors the
 * discipline in `lib/plugin/convert/scaffold.ts` — the generator returns a file
 * map and never writes.
 *
 * Every generated manifest is guaranteed to round-trip through
 * {@link parseSiteHostingManifest}; the suite asserts that for each kind.
 */
import type { SiteHostingManifest } from "./manifest"

export type SiteProjectKind =
  "next" | "astro" | "sveltekit" | "remix" | "vite" | "static" | "node" | "unknown"

export type SitePackageManager = "pnpm" | "npm" | "yarn" | "bun"

/**
 * How much the scaffold actually knows.
 *
 * `detected` — a framework was identified, so the build command and output
 * directory match that framework's defaults.
 * `template` — nothing recognizable was found. The manifest is a plausible
 * skeleton the user MUST edit; the UI labels it as such rather than implying
 * the guess is trustworthy.
 */
export type SiteScaffoldConfidence = "detected" | "template"

export interface SiteProjectProbe {
  /** Top-level entry names of the Site's source directory. */
  entries: readonly string[]
  /** Raw `package.json` text from the source directory, when present. */
  packageJson?: string
  /** Top-level entry names of the workspace root, for lockfile detection. */
  rootEntries?: readonly string[]
}

export interface SiteScaffoldFile {
  /** Relative to the Site's source directory. */
  relativePath: string
  contents: string
}

export interface SiteScaffoldResult {
  kind: SiteProjectKind
  packageManager: SitePackageManager
  confidence: SiteScaffoldConfidence
  manifest: SiteHostingManifest
  /** Files that must be written alongside the manifest. */
  extraFiles: SiteScaffoldFile[]
}

export interface SiteScaffoldOptions {
  packageManager: SitePackageManager
  /** YYYY-MM-DD. Passed in so this module stays clock-free. */
  compatibilityDate: string
}

/**
 * The generated Worker entry.
 *
 * `wrangler versions upload <entry> --assets <dir>` (see
 * `lib/sites/cloudflare/version-uploader.ts`) creates the `ASSETS` binding from
 * the built output, so the entry only has to hand requests to it. We always
 * generate this rather than guessing a framework's Worker output path: this is
 * the one entry file we can guarantee exists, because we write it.
 */
export const SITE_WORKER_ENTRY_PATH = ".cognia/worker.js"

export const SITE_WORKER_ENTRY_SOURCE = `/**
 * Cognia Sites — generated static-asset Worker.
 *
 * Cognia uploads this file with \`wrangler versions upload --assets <dir>\`,
 * which binds the built output to \`env.ASSETS\`. Add your own routing above
 * the fallback if the Site needs server-side behaviour.
 */
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request)
  },
}
`

/** Build output directory per framework, relative to the source directory. */
const OUTPUT_DIR: Record<SiteProjectKind, string> = {
  next: "out",
  astro: "dist",
  sveltekit: "build",
  remix: "build/client",
  vite: "dist",
  static: "dist",
  node: "dist",
  unknown: "dist",
}

/** Dev-server origin per framework. Must be localhost — the parser enforces it. */
const PREVIEW_URL: Record<SiteProjectKind, string> = {
  next: "http://localhost:3000",
  astro: "http://localhost:4321",
  sveltekit: "http://localhost:5173",
  remix: "http://localhost:5173",
  vite: "http://localhost:5173",
  static: "http://localhost:3000",
  node: "http://localhost:3000",
  unknown: "http://localhost:3000",
}

const DEPENDENCY_KIND: ReadonlyArray<[string, SiteProjectKind]> = [
  ["next", "next"],
  ["astro", "astro"],
  ["@sveltejs/kit", "sveltekit"],
  ["@remix-run/dev", "remix"],
  ["vite", "vite"],
]

const CONFIG_KIND: ReadonlyArray<[RegExp, SiteProjectKind]> = [
  [/^next\.config\.[cm]?[jt]s$/, "next"],
  [/^astro\.config\.[cm]?[jt]s$/, "astro"],
  [/^svelte\.config\.[cm]?[jt]s$/, "sveltekit"],
  [/^remix\.config\.[cm]?[jt]s$/, "remix"],
  [/^vite\.config\.[cm]?[jt]s$/, "vite"],
]

/** Lockfile → package manager, in precedence order. */
const LOCKFILE_MANAGER: ReadonlyArray<[string, SitePackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
]

function dependencyNames(packageJson: string | undefined): Set<string> {
  if (!packageJson) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(packageJson)
  } catch {
    // A malformed package.json is a detection miss, not a scaffold failure —
    // the user still gets the template manifest.
    return new Set()
  }
  if (!parsed || typeof parsed !== "object") return new Set()
  const record = parsed as Record<string, unknown>
  const names = new Set<string>()
  for (const field of ["dependencies", "devDependencies"]) {
    const group = record[field]
    if (!group || typeof group !== "object") continue
    for (const name of Object.keys(group as Record<string, unknown>)) names.add(name)
  }
  return names
}

/**
 * Identify the framework. Declared dependencies win over config-file names: a
 * repo can carry a stale `vite.config.ts` long after it moved to Next.
 */
export function detectSiteProjectKind(probe: SiteProjectProbe): SiteProjectKind {
  const dependencies = dependencyNames(probe.packageJson)
  for (const [name, kind] of DEPENDENCY_KIND) {
    if (dependencies.has(name)) return kind
  }
  for (const entry of probe.entries) {
    for (const [pattern, kind] of CONFIG_KIND) {
      if (pattern.test(entry)) return kind
    }
  }
  if (!probe.packageJson) return probe.entries.includes("index.html") ? "static" : "unknown"
  return "node"
}

/** Resolve the package manager from the workspace lockfile, defaulting to pnpm. */
export function detectSitePackageManager(probe: SiteProjectProbe): SitePackageManager {
  const candidates = [...(probe.rootEntries ?? []), ...probe.entries]
  for (const [lockfile, manager] of LOCKFILE_MANAGER) {
    if (candidates.includes(lockfile)) return manager
  }
  return "pnpm"
}

/** True when the kind carries real framework defaults rather than a skeleton. */
export function siteScaffoldConfidence(kind: SiteProjectKind): SiteScaffoldConfidence {
  return kind === "static" || kind === "node" || kind === "unknown" ? "template" : "detected"
}

export function scaffoldSiteHostingManifest(
  kind: SiteProjectKind,
  options: SiteScaffoldOptions
): SiteScaffoldResult {
  const { packageManager, compatibilityDate } = options
  const manifest: SiteHostingManifest = {
    schemaVersion: 1,
    build: {
      install: [packageManager, "install"],
      command: [packageManager, "run", "build"],
      entry: SITE_WORKER_ENTRY_PATH,
      assets: OUTPUT_DIR[kind],
    },
    preview: {
      command: [packageManager, "run", "dev"],
      url: PREVIEW_URL[kind],
    },
    cloudflare: {
      compatibilityDate,
      compatibilityFlags: [],
      bindings: [],
    },
  }
  return {
    kind,
    packageManager,
    confidence: siteScaffoldConfidence(kind),
    manifest,
    extraFiles: [{ relativePath: SITE_WORKER_ENTRY_PATH, contents: SITE_WORKER_ENTRY_SOURCE }],
  }
}

/** Probe → complete scaffold, the form the manifest editor calls. */
export function scaffoldSiteHostingManifestFromProbe(
  probe: SiteProjectProbe,
  compatibilityDate: string
): SiteScaffoldResult {
  return scaffoldSiteHostingManifest(detectSiteProjectKind(probe), {
    packageManager: detectSitePackageManager(probe),
    compatibilityDate,
  })
}

/** Stable, human-editable serialization of a scaffolded manifest. */
export function serializeSiteHostingManifest(manifest: SiteHostingManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

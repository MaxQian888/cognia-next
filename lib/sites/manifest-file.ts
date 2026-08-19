/**
 * Locate, read, and write a Site's `.cognia/hosting.json`.
 *
 * The manifest is the single source of truth for the build argv, the preview
 * command, the Worker entry/assets, and the Cloudflare bindings. Three call
 * sites used to inline `join(sourceDir, ".cognia", "hosting.json")` and a bare
 * `readTextFile` — the build path, the preview path, and the dashboard's
 * provision handler — which is why a missing manifest surfaced as a raw
 * file-read error with no way to fix it in-app. This module owns the path, the
 * three-state read, and the write.
 *
 * Every host dependency is injectable so the callers stay unit-testable
 * without Tauri (same shape as `lib/sites/preview.ts`).
 */
import { createDir, exists, readDir, readTextFile, writeTextFile } from "@/lib/file/file-operations"
import { parseSiteHostingManifest, type SiteHostingManifest } from "./manifest"
import type { SiteProjectProbe, SiteScaffoldFile } from "./manifest-scaffold"
import type { SiteProjectRow } from "@/types/sites"

export const SITE_MANIFEST_DIR = ".cognia"
export const SITE_MANIFEST_FILE = "hosting.json"
/** Display path, always POSIX-shaped regardless of host. */
export const SITE_MANIFEST_RELATIVE_PATH = `${SITE_MANIFEST_DIR}/${SITE_MANIFEST_FILE}`

export interface SiteManifestFileDeps {
  join: (...parts: string[]) => Promise<string>
  readText: typeof readTextFile
  writeText: typeof writeTextFile
  mkdir: typeof createDir
  listDir: typeof readDir
  pathExists: typeof exists
}

function defaults(): SiteManifestFileDeps {
  return {
    join: async (...parts) => {
      const path = await import("@tauri-apps/api/path")
      return path.join(...parts)
    },
    readText: readTextFile,
    writeText: writeTextFile,
    mkdir: createDir,
    listDir: readDir,
    pathExists: exists,
  }
}

function resolve(dependencies?: Partial<SiteManifestFileDeps>): SiteManifestFileDeps {
  return { ...defaults(), ...dependencies }
}

/** Absolute directory the Site builds from: source root plus its subpath. */
export async function resolveSiteSourceDir(
  site: Pick<SiteProjectRow, "sourceRoot" | "sourceSubpath">,
  join: SiteManifestFileDeps["join"]
): Promise<string> {
  return site.sourceSubpath
    ? join(site.sourceRoot, ...site.sourceSubpath.split("/"))
    : site.sourceRoot
}

/** Absolute path of the Site's hosting manifest. */
export async function resolveSiteManifestPath(
  site: Pick<SiteProjectRow, "sourceRoot" | "sourceSubpath">,
  join: SiteManifestFileDeps["join"]
): Promise<string> {
  return join(await resolveSiteSourceDir(site, join), SITE_MANIFEST_DIR, SITE_MANIFEST_FILE)
}

export type SiteManifestReadResult =
  | { status: "ok"; path: string; text: string; manifest: SiteHostingManifest }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; text: string; error: string }

/**
 * Read and validate the manifest.
 *
 * Absence is a first-class state, not an error: it is the normal condition for
 * a Site that has never been configured, and the console offers a scaffold for
 * exactly that case. A present-but-unparseable manifest keeps its text so the
 * editor can show the user what to fix.
 */
export async function readSiteHostingManifestFile(
  site: Pick<SiteProjectRow, "sourceRoot" | "sourceSubpath">,
  dependencies?: Partial<SiteManifestFileDeps>
): Promise<SiteManifestReadResult> {
  const deps = resolve(dependencies)
  const path = await resolveSiteManifestPath(site, deps.join)
  if (!(await deps.pathExists(path))) return { status: "missing", path }
  let text: string
  try {
    text = await deps.readText(path)
  } catch {
    // A file that exists but cannot be read is indistinguishable from absence
    // for the user's next action: they have to write one.
    return { status: "missing", path }
  }
  try {
    return { status: "ok", path, text, manifest: parseSiteHostingManifest(text) }
  } catch (error) {
    return {
      status: "invalid",
      path,
      text,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Write the manifest and any companion files (the generated Worker entry)
 * relative to the Site's source directory, creating parent directories first.
 */
export async function writeSiteHostingManifestFile(
  site: Pick<SiteProjectRow, "sourceRoot" | "sourceSubpath">,
  input: { manifestText: string; extraFiles?: readonly SiteScaffoldFile[] },
  dependencies?: Partial<SiteManifestFileDeps>
): Promise<string> {
  const deps = resolve(dependencies)
  const sourceDir = await resolveSiteSourceDir(site, deps.join)
  const manifestPath = await deps.join(sourceDir, SITE_MANIFEST_DIR, SITE_MANIFEST_FILE)
  await deps.mkdir(await deps.join(sourceDir, SITE_MANIFEST_DIR), { recursive: true })
  for (const file of input.extraFiles ?? []) {
    const segments = file.relativePath.split("/")
    if (segments.length > 1) {
      await deps.mkdir(await deps.join(sourceDir, ...segments.slice(0, -1)), { recursive: true })
    }
    await deps.writeText(await deps.join(sourceDir, ...segments), file.contents)
  }
  await deps.writeText(manifestPath, input.manifestText)
  return manifestPath
}

/**
 * Collect what {@link import("./manifest-scaffold").detectSiteProjectKind}
 * needs: the source directory listing, its `package.json` when present, and the
 * workspace root listing for lockfile detection.
 */
export async function probeSiteSource(
  site: Pick<SiteProjectRow, "sourceRoot" | "sourceSubpath">,
  dependencies?: Partial<SiteManifestFileDeps>
): Promise<SiteProjectProbe> {
  const deps = resolve(dependencies)
  const sourceDir = await resolveSiteSourceDir(site, deps.join)
  const entries = await deps.listDir(sourceDir)
  const rootEntries =
    sourceDir === site.sourceRoot ? entries : await deps.listDir(site.sourceRoot).catch(() => [])
  let packageJson: string | undefined
  if (entries.includes("package.json")) {
    packageJson = await deps
      .readText(await deps.join(sourceDir, "package.json"))
      .catch(() => undefined)
  }
  return { entries, rootEntries, ...(packageJson === undefined ? {} : { packageJson }) }
}

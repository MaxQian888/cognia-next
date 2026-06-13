/**
 * Provenance store for CLI-installed GitHub plugins. The desktop tracks install
 * source + version in Dexie; the CLI has no Dexie, so we mirror the JSON-file
 * style of `marketplace-sources.ts`: `~/.cognia/plugin-origins.json` holding
 * `{ "origins": { "<id>": { repoRef, version, fingerprint, installedAt } } }`.
 *
 * This is what makes `/plugin update` possible — without a recorded `repoRef`
 * there is no way to know where to re-fetch a plugin from. The `fingerprint`
 * (SHA-256 of the installed bundle) lets update report "content changed" vs
 * "already up to date".
 */
import nodeFs from "node:fs"
import path from "node:path"

export interface PluginOrigin {
  /** The GitHub ref the plugin was installed from (`owner/repo[@ref][/subdir]`). */
  repoRef: string
  /** Manifest version at install time. */
  version: string
  /** SHA-256 of the installed bundle (rel-path-sorted contents). */
  fingerprint: string
  /** Wall-clock ms of the (re)install. */
  installedAt: number
}

export interface OriginsFs {
  readFileSync: (p: string, enc?: BufferEncoding) => string
  writeFileSync: (p: string, data: string) => void
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void
}

const defaultFs: OriginsFs = {
  readFileSync: (p) => nodeFs.readFileSync(p, "utf8"),
  writeFileSync: (p, d) => nodeFs.writeFileSync(p, d),
  mkdirSync: (p, o) => void nodeFs.mkdirSync(p, o),
}

function originsPath(home: string): string {
  return path.join(home, ".cognia", "plugin-origins.json")
}

/** Read all recorded plugin origins keyed by id. Returns {} on any error. */
export function readOrigins(home: string, fs: OriginsFs = defaultFs): Record<string, PluginOrigin> {
  try {
    const parsed = JSON.parse(fs.readFileSync(originsPath(home), "utf8")) as { origins?: unknown }
    const raw = parsed.origins
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const out: Record<string, PluginOrigin> = {}
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue
      const o = value as Record<string, unknown>
      if (typeof o.repoRef !== "string") continue
      out[id] = {
        repoRef: o.repoRef,
        version: typeof o.version === "string" ? o.version : "0.0.0",
        fingerprint: typeof o.fingerprint === "string" ? o.fingerprint : "",
        installedAt: typeof o.installedAt === "number" ? o.installedAt : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Read a single plugin's origin, or undefined when not GitHub-installed. */
export function getOrigin(
  home: string,
  id: string,
  fs: OriginsFs = defaultFs
): PluginOrigin | undefined {
  return readOrigins(home, fs)[id]
}

function writeOrigins(home: string, origins: Record<string, PluginOrigin>, fs: OriginsFs): void {
  fs.mkdirSync(path.join(home, ".cognia"), { recursive: true })
  fs.writeFileSync(originsPath(home), JSON.stringify({ origins }, null, 2))
}

/** Record (or overwrite) a plugin's install provenance. */
export function recordOrigin(
  home: string,
  id: string,
  entry: { repoRef: string; version: string; fingerprint: string; installedAt?: number },
  fs: OriginsFs = defaultFs
): void {
  const origins = readOrigins(home, fs)
  origins[id] = {
    repoRef: entry.repoRef,
    version: entry.version,
    fingerprint: entry.fingerprint,
    installedAt: entry.installedAt ?? Date.now(),
  }
  writeOrigins(home, origins, fs)
}

/** Drop a plugin's origin (on uninstall). No-op for unknown ids. */
export function removeOrigin(home: string, id: string, fs: OriginsFs = defaultFs): void {
  const origins = readOrigins(home, fs)
  if (!(id in origins)) return
  delete origins[id]
  writeOrigins(home, origins, fs)
}

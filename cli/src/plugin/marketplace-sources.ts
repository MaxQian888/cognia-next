/**
 * GitHub marketplace source store for the CLI. The desktop persists these in
 * the `pluginMarketplaceSources` Dexie table; the CLI has no Dexie, so we mirror
 * it as a JSON file under the home dir: `~/.cognia/plugin-marketplace-sources.json`
 * holding `{ "sources": ["owner/repo[@ref]", ...] }`. Mirrors the synchronous,
 * graceful-default style of `plugin-state.ts`.
 */
import nodeFs from "node:fs"
import path from "node:path"

export interface SourcesFs {
  readFileSync: (p: string, enc?: BufferEncoding) => string
  writeFileSync: (p: string, data: string) => void
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void
}

const defaultFs: SourcesFs = {
  readFileSync: (p) => nodeFs.readFileSync(p, "utf8"),
  writeFileSync: (p, d) => nodeFs.writeFileSync(p, d),
  mkdirSync: (p, o) => void nodeFs.mkdirSync(p, o),
}

function sourcesPath(home: string): string {
  return path.join(home, ".cognia", "plugin-marketplace-sources.json")
}

/** Read the configured GitHub marketplace sources. Returns [] on any error. */
export function readSources(home: string, fs: SourcesFs = defaultFs): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(sourcesPath(home), "utf8")) as { sources?: unknown }
    return Array.isArray(parsed.sources)
      ? parsed.sources.filter((s): s is string => typeof s === "string")
      : []
  } catch {
    return []
  }
}

function writeSources(home: string, sources: string[], fs: SourcesFs): void {
  fs.mkdirSync(path.join(home, ".cognia"), { recursive: true })
  fs.writeFileSync(sourcesPath(home), JSON.stringify({ sources }, null, 2))
}

/** Add a source (deduped, trimmed). Returns the resulting list. */
export function addSource(home: string, repoRef: string, fs: SourcesFs = defaultFs): string[] {
  const ref = repoRef.trim()
  const current = readSources(home, fs)
  if (!ref || current.includes(ref)) return current
  const next = [...current, ref]
  writeSources(home, next, fs)
  return next
}

/** Remove a source. Returns the resulting list. */
export function removeSource(home: string, repoRef: string, fs: SourcesFs = defaultFs): string[] {
  const next = readSources(home, fs).filter((s) => s !== repoRef)
  writeSources(home, next, fs)
  return next
}

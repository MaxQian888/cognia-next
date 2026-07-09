// Registry of agent session-history sources. Static first-party sources plus a
// runtime plugin overlay — the exact ownership/dedupe pattern proven in
// `lib/data/import-registry.ts` (§A-4) and the ADR-0051 external-agent-adapter
// overlay: static sources are authoritative, plugin sources are appended and
// namespaced `${pluginId}:${id}`, and a plugin can never shadow a built-in.

import { aiderSessionSource } from "./adapters/aider"
import { claudeCodeSessionSource } from "./adapters/claude-code"
import { codexSessionSource } from "./adapters/codex"
import { continueDevSessionSource } from "./adapters/continue-dev"
import { geminiCliSessionSource } from "./adapters/gemini-cli"
import { opencodeSessionSource } from "./adapters/opencode"
import type { AgentSessionSourceAdapter, PickedSessionFile } from "./types"

/** Static, ordered for auto-detect priority. */
const STATIC_SOURCES: AgentSessionSourceAdapter[] = [
  claudeCodeSessionSource,
  codexSessionSource,
  opencodeSessionSource,
  geminiCliSessionSource,
  continueDevSessionSource,
  aiderSessionSource,
]

interface RegisteredSource {
  adapter: AgentSessionSourceAdapter
  pluginId?: string
}

const dynamicSources: RegisteredSource[] = []

const STATIC_IDS = new Set(STATIC_SOURCES.map((s) => s.id))

/**
 * Register a session source at runtime. Dynamic sources are evaluated AFTER the
 * static list, so a plugin cannot shadow a built-in. When `pluginId` is given
 * the source id is namespaced `${pluginId}:${id}` unless it already carries a
 * `:` prefix. Returns a disposer that removes exactly this registration.
 */
export function registerSessionSource(
  adapter: AgentSessionSourceAdapter,
  opts: { pluginId?: string } = {}
): () => void {
  const { pluginId } = opts
  const id = pluginId && !adapter.id.includes(":") ? `${pluginId}:${adapter.id}` : adapter.id
  if (STATIC_IDS.has(id)) {
    // Refuse to register over a built-in id (defensive — mirrors ADR-0051).
    return () => {}
  }
  const normalized: AgentSessionSourceAdapter = { ...adapter, id }
  const entry: RegisteredSource = { adapter: normalized, pluginId }
  dynamicSources.push(entry)
  return () => {
    const idx = dynamicSources.indexOf(entry)
    if (idx !== -1) dynamicSources.splice(idx, 1)
  }
}

/** Drop every dynamic source tagged with `pluginId`. Returns the count removed. */
export function unregisterSessionSourcesByPlugin(pluginId: string): number {
  let removed = 0
  for (let i = dynamicSources.length - 1; i >= 0; i -= 1) {
    if (dynamicSources[i].pluginId === pluginId) {
      dynamicSources.splice(i, 1)
      removed += 1
    }
  }
  return removed
}

/** Test-only escape hatch for cleaning up the dynamic overlay between tests. */
export function __resetDynamicSessionSourcesForTesting(): void {
  dynamicSources.length = 0
}

/** All sources, static first then dynamic (registration order). */
export function getSessionSources(): AgentSessionSourceAdapter[] {
  return [...STATIC_SOURCES, ...dynamicSources.map((d) => d.adapter)]
}

/** Look up a source by id, or undefined. */
export function getSessionSource(id: string): AgentSessionSourceAdapter | undefined {
  return getSessionSources().find((s) => s.id === id)
}

/** Normalize separators + drop trailing slashes for a prefix comparison. */
function normalizeSep(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "")
}

/**
 * The source whose desktop scan roots contain `path`, or undefined. Lets the
 * live-sync watcher re-import only the changed agent's history on an fs event
 * instead of re-scanning every source. Static sources are checked first, so a
 * plugin whose root nests under a built-in's can never shadow it.
 */
export function detectSourceForPath(
  path: string,
  home: string
): AgentSessionSourceAdapter | undefined {
  const norm = normalizeSep(path)
  for (const source of getSessionSources()) {
    for (const root of source.scanRoots(home)) {
      const r = normalizeSep(root)
      if (r && (norm === r || norm.startsWith(`${r}/`))) return source
    }
  }
  return undefined
}

/**
 * Best-effort source detection for a batch of hand-picked files. First "match"
 * wins, else the first "maybe". Returns null when every source says "no".
 */
export function detectSourceForFiles(files: PickedSessionFile[]): string | null {
  let firstMaybe: string | null = null
  for (const source of getSessionSources()) {
    const verdict = source.detect(files)
    if (verdict === "match") return source.id
    if (verdict === "maybe" && firstMaybe === null) firstMaybe = source.id
  }
  return firstMaybe
}

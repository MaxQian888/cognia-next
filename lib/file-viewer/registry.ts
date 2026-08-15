/**
 * Which viewer renders a given file.
 *
 * Modelled on `lib/context-workbench/panel-registry.ts` — throw on a duplicate
 * id, return a disposer, sort deterministically, and expose a revision so a
 * component can subscribe with `useSyncExternalStore`.
 *
 * The host owns every read. A contribution receives text that has already been
 * confined to a workspace root and size-checked; it never receives a path it
 * could resolve. That is the invariant this module exists to keep, and the
 * reason `matches` is handed a probe rather than a request.
 */
import { BUILTIN_FILE_VIEWERS } from "./builtins"
import type { FileViewerContribution, FileViewerProbe } from "./types"

const contributions = new Map<string, FileViewerContribution>()
const listeners = new Set<() => void>()
let revision = 0

function notify(): void {
  revision += 1
  listeners.forEach((listener) => listener())
}

function seedBuiltins(): void {
  for (const contribution of BUILTIN_FILE_VIEWERS) {
    contributions.set(contribution.id, contribution)
  }
}

// Seeded at module init rather than on first render, so the answer does not
// depend on whether any component has mounted yet — `isProjectFilePreviewable`
// is called during render by four unrelated trees.
seedBuiltins()

export function registerFileViewer(contribution: FileViewerContribution): () => void {
  if (contributions.has(contribution.id)) {
    throw new Error(`File viewer id already registered: ${contribution.id}`)
  }
  contributions.set(contribution.id, contribution)
  notify()
  return () => {
    // Guarded by identity: a disposer that ran after the id was re-registered
    // by someone else would otherwise delete the newcomer's entry.
    if (contributions.get(contribution.id) !== contribution) return
    contributions.delete(contribution.id)
    notify()
  }
}

export function resolveFileViewer(probe: FileViewerProbe): FileViewerContribution | null {
  let best: FileViewerContribution | null = null
  for (const contribution of contributions.values()) {
    if (!contribution.matches(probe)) continue
    if (
      best === null ||
      contribution.priority > best.priority ||
      // Ties by id, so the winner does not depend on registration order —
      // which varies with module evaluation order across platforms and tests.
      (contribution.priority === best.priority && contribution.id.localeCompare(best.id) < 0)
    ) {
      best = contribution
    }
  }
  return best
}

export function listFileViewers(): readonly FileViewerContribution[] {
  return [...contributions.values()]
}

export function subscribeFileViewers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getFileViewerRevision(): number {
  return revision
}

/**
 * Re-seeds the built-ins rather than emptying the map.
 *
 * A reset that cleared everything would silently break
 * `isProjectFilePreviewable` for every later case in the same test file, which
 * is a slow and confusing way to find out the helper is global.
 */
export function __resetFileViewersForTesting(): void {
  contributions.clear()
  seedBuiltins()
  notify()
}

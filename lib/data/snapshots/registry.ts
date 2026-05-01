// Central registry of every Zustand-persist snapshot module the v3 backup
// pipeline knows about. Adding a new persist store to the backup is two
// lines here and one new module file in `lib/data/snapshots/<name>.ts`.

import type { SnapshotModule } from "./types"
import { externalAgentsSnapshot } from "./external-agents"
import { customModesSnapshot } from "./custom-modes"
import { agentTeamsSnapshot } from "./agent-teams"
import { a2uiSurfacesSnapshot } from "./a2ui-surfaces"
import { artifactsSnapshot } from "./artifacts"
import { agentRuntimeSnapshot } from "./agent-runtime"
import { customThemesSnapshot } from "./custom-themes"
import { schedulerSnapshot } from "./scheduler"
import { canvasKeybindingsSnapshot } from "./canvas-keybindings"
import { canvasCommentsSnapshot } from "./canvas-comments"
import { canvasSettingsSnapshot } from "./canvas-settings"
import { uiSnapshot } from "./ui"

/** Order matters only for deterministic iteration in builds & UI lists.
 * Rough order: agent-related first, then user content, then UI prefs. */
export const SNAPSHOT_MODULES: ReadonlyArray<SnapshotModule> = [
  externalAgentsSnapshot,
  customModesSnapshot,
  agentTeamsSnapshot,
  agentRuntimeSnapshot,
  customThemesSnapshot,
  artifactsSnapshot,
  a2uiSurfacesSnapshot,
  canvasKeybindingsSnapshot,
  canvasCommentsSnapshot,
  canvasSettingsSnapshot,
  schedulerSnapshot,
  uiSnapshot,
]

const KEYS = new Set(SNAPSHOT_MODULES.map((m) => m.key))

if (KEYS.size !== SNAPSHOT_MODULES.length) {
  // This is a developer-error guard: registering the same persist key twice
  // would silently let one module's writes shadow the other.
  throw new Error("SNAPSHOT_MODULES has duplicate keys")
}

export function getSnapshotModule(key: string): SnapshotModule | undefined {
  return SNAPSHOT_MODULES.find((m) => m.key === key)
}

export function listSnapshotKeys(): string[] {
  return SNAPSHOT_MODULES.map((m) => m.key)
}

/** Modules whose `exposeAsDomain` is true — used by `domain/index.ts`. */
export const DOMAIN_SNAPSHOT_MODULES: ReadonlyArray<SnapshotModule> = SNAPSHOT_MODULES.filter(
  (m) => m.exposeAsDomain
)

/** Build a `SnapshotEnv.storage` from the browser `localStorage` if it
 * exists, otherwise return `null`. Centralized so callers don't repeat the
 * `typeof localStorage !== "undefined"` dance. */
export function browserSnapshotStorage(): {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
} | null {
  if (typeof globalThis === "undefined") return null
  const ls = (globalThis as { localStorage?: Storage }).localStorage
  if (!ls) return null
  return {
    getItem: (k) => ls.getItem(k),
    setItem: (k, v) => ls.setItem(k, v),
    removeItem: (k) => ls.removeItem(k),
  }
}

// Leaf module for the Workspace (Project) isolation model. Holds the
// default-workspace id + a pure factory so BOTH the runtime scope helper
// (`project-scope.ts`) and the v86 upgrade backfill (`project-scope-backfill.ts`)
// produce an identical Default project shape without importing `getDb` — that
// keeps the schema-upgrade path free of a module cycle back into `schema.ts`.
//
// Two-layer isolation model (see CLAUDE.md): this is the Workspace layer. A
// future Profile layer wraps everything one level out (DB-name prefix / keyring
// namespace) and never needs to touch this file.

import type { Project } from "@/types"

/**
 * Stable id for the auto-created fallback workspace. Fixed (not a nanoid) so
 * `ensureDefaultProject()` is idempotent and the migration backfill is
 * deterministic and testable.
 */
export const DEFAULT_PROJECT_ID = "project-default"

/**
 * The data-default name for the fallback workspace. A plain literal — this is
 * a stored data value, not a rendered JSX string, mirroring the existing
 * `"New Project"` literal in `project-store.ts:createProject`. It is therefore
 * outside the `lint:i18n` surface (which scans `.tsx`).
 */
export const DEFAULT_PROJECT_NAME = "Default"

/**
 * Build the canonical Default workspace row. Used by the runtime null-resolution
 * path and by the v86 backfill when no active project and no projects exist.
 */
export function buildDefaultProject(now = Date.now()): Project {
  const date = new Date(now)
  return {
    id: DEFAULT_PROJECT_ID,
    name: DEFAULT_PROJECT_NAME,
    roots: [],
    knowledgeBase: [],
    sessionIds: [],
    sessionCount: 0,
    messageCount: 0,
    isArchived: false,
    createdAt: date,
    updatedAt: date,
    lastAccessedAt: date,
  }
}

// Snapshot for `localStorage["cognia-scheduler"]`. The store's `partialize`
// keeps only UI preferences (filter / interval / policy) — running task
// rows live in IndexedDB through `scheduler-db.ts`. We back up the prefs;
// the rows ride along with Dexie.

import { createGenericSnapshotModule } from "./factory"

export const SCHEDULER_PERSIST_KEY = "cognia-scheduler"
export const SCHEDULER_LABEL_KEY = "schedulerPrefs"

export const schedulerSnapshot = createGenericSnapshotModule({
  key: SCHEDULER_PERSIST_KEY,
  labelKey: SCHEDULER_LABEL_KEY,
  exposeAsDomain: true,
})

// Snapshot for `localStorage["cognia-a2ui-surfaces"]`. The Dexie `a2uiApps /
// a2uiTemplates / a2uiEventHistory` tables already round-trip via v3, but
// the *surface registry* (active surface ids, recent event history,
// rendering preferences) lives in Zustand and was previously lost on
// restore.

import { createGenericSnapshotModule } from "./factory"

export const A2UI_SURFACES_PERSIST_KEY = "cognia-a2ui-surfaces"
export const A2UI_SURFACES_LABEL_KEY = "a2uiSurfaces"

export const a2uiSurfacesSnapshot = createGenericSnapshotModule({
  key: A2UI_SURFACES_PERSIST_KEY,
  labelKey: A2UI_SURFACES_LABEL_KEY,
  exposeAsDomain: true,
  maxBytesWarn: 1_000_000,
})

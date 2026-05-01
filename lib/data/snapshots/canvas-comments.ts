// Snapshot for `localStorage["cognia-canvas-comments"]`. This is *not* the
// Dexie `canvasComments` table — it's a docId→comments cache the canvas UI
// keeps in zustand for fast hydration. Backing it up keeps the canvas
// experience uninterrupted across a restore even before Dexie hydrates.

import { createGenericSnapshotModule } from "./factory"

export const CANVAS_COMMENTS_PERSIST_KEY = "cognia-canvas-comments"
export const CANVAS_COMMENTS_LABEL_KEY = "canvasCommentsCache"

export const canvasCommentsSnapshot = createGenericSnapshotModule({
  key: CANVAS_COMMENTS_PERSIST_KEY,
  labelKey: CANVAS_COMMENTS_LABEL_KEY,
  exposeAsDomain: true,
  maxBytesWarn: 1_000_000,
})

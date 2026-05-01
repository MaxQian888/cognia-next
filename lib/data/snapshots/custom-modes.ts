// Snapshot for `localStorage["cognia-custom-modes"]`. The live store
// serializes Date instances to ISO strings via `partialize` and revives them
// in `onRehydrateStorage`. We never see Date objects on disk — the wire
// format is already strings — so the generic factory works as-is.

import { createGenericSnapshotModule } from "./factory"

export const CUSTOM_MODES_PERSIST_KEY = "cognia-custom-modes"
export const CUSTOM_MODES_LABEL_KEY = "customModes"

export const customModesSnapshot = createGenericSnapshotModule({
  key: CUSTOM_MODES_PERSIST_KEY,
  labelKey: CUSTOM_MODES_LABEL_KEY,
  exposeAsDomain: true,
  maxBytesWarn: 800_000,
})

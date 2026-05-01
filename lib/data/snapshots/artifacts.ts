// Snapshot for `localStorage["cognia-artifacts"]`. The artifact-store can be
// the largest persisted face on disk (artifacts + versions + canvas
// documents + analysis results all sit in the same Zustand persist). We set
// a 2 MB warn threshold per the plan; once the user nears 5 MB we strongly
// recommend migrating this store to IndexedDB (separate work).

import { createGenericSnapshotModule } from "./factory"

export const ARTIFACTS_PERSIST_KEY = "cognia-artifacts"
export const ARTIFACTS_LABEL_KEY = "artifacts"
export const ARTIFACTS_SIZE_WARN_BYTES = 2_000_000

export const artifactsSnapshot = createGenericSnapshotModule({
  key: ARTIFACTS_PERSIST_KEY,
  labelKey: ARTIFACTS_LABEL_KEY,
  exposeAsDomain: true,
  maxBytesWarn: ARTIFACTS_SIZE_WARN_BYTES,
})

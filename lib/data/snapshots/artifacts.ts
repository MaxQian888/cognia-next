// Snapshot for `localStorage["cognia-artifacts"]`.
//
// This blob used to be the largest persisted face on disk — artifacts, their
// version history and canvas documents all shared one Zustand persist, which
// is why it carries a 2 MB warn threshold. The artifacts moved to Dexie in
// schema v206 (`lib/artifacts/dexie-bridge.ts`), so what is left is dock
// preferences: the workspace filters, the per-session tab strip, and which
// artifact each conversation was parked on.
//
// `exposeAsDomain` is therefore false: the "Artifacts" transfer domain reads
// the Dexie tables now (`lib/data/domain/index.ts`). The module stays
// registered so a full backup still round-trips those preferences, and so an
// export written before v206 — whose artifacts are inside this blob — still
// applies.

import { createGenericSnapshotModule } from "./factory"

export const ARTIFACTS_PERSIST_KEY = "cognia-artifacts"
export const ARTIFACTS_LABEL_KEY = "artifacts"
export const ARTIFACTS_SIZE_WARN_BYTES = 2_000_000

export const artifactsSnapshot = createGenericSnapshotModule({
  key: ARTIFACTS_PERSIST_KEY,
  labelKey: ARTIFACTS_LABEL_KEY,
  exposeAsDomain: false,
  maxBytesWarn: ARTIFACTS_SIZE_WARN_BYTES,
})

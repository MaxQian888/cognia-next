// Snapshot for `localStorage["cognia-ui"]`. Window-layout preferences
// (selectedGuild, sidebar/rail layout, scratchpadCollapsed). UI-only — not
// exposed as a standalone domain to avoid cluttering the domain export
// menu, but still part of the full backup so a restore lands the user in
// the same shell layout they had.

import { createGenericSnapshotModule } from "./factory"

export const UI_PERSIST_KEY = "cognia-ui"
export const UI_LABEL_KEY = "uiPreferences"

export const uiSnapshot = createGenericSnapshotModule({
  key: UI_PERSIST_KEY,
  labelKey: UI_LABEL_KEY,
  exposeAsDomain: false,
})

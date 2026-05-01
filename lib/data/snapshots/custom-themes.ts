// Snapshot for `localStorage["cognia-custom-themes"]`. The Dexie-backed
// `settingsTheme` domain only carries the *active* appearance fields; user-
// created custom themes (the list of palettes the user has built and saved)
// live here as a separate face. Both are needed for a full restore.

import { createGenericSnapshotModule } from "./factory"

export const CUSTOM_THEMES_PERSIST_KEY = "cognia-custom-themes"
export const CUSTOM_THEMES_LABEL_KEY = "customThemes"

export const customThemesSnapshot = createGenericSnapshotModule({
  key: CUSTOM_THEMES_PERSIST_KEY,
  labelKey: CUSTOM_THEMES_LABEL_KEY,
  exposeAsDomain: true,
})

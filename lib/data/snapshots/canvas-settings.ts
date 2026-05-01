// Snapshot for `localStorage["cognia-canvas-settings"]`. Per-user canvas
// preferences (font, line numbers, theme, autosave interval, …).

import { createGenericSnapshotModule } from "./factory"

export const CANVAS_SETTINGS_PERSIST_KEY = "cognia-canvas-settings"
export const CANVAS_SETTINGS_LABEL_KEY = "canvasSettings"

export const canvasSettingsSnapshot = createGenericSnapshotModule({
  key: CANVAS_SETTINGS_PERSIST_KEY,
  labelKey: CANVAS_SETTINGS_LABEL_KEY,
  exposeAsDomain: true,
})

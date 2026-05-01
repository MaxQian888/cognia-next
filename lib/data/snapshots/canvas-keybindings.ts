// Snapshot for `localStorage["cognia-canvas-keybindings"]`. Personal
// keybinding overrides aren't recoverable from anywhere else, so they must
// ride along with the backup.

import { createGenericSnapshotModule } from "./factory"

export const CANVAS_KEYBINDINGS_PERSIST_KEY = "cognia-canvas-keybindings"
export const CANVAS_KEYBINDINGS_LABEL_KEY = "canvasKeybindings"

export const canvasKeybindingsSnapshot = createGenericSnapshotModule({
  key: CANVAS_KEYBINDINGS_PERSIST_KEY,
  labelKey: CANVAS_KEYBINDINGS_LABEL_KEY,
  exposeAsDomain: true,
})

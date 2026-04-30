/**
 * Cognia compatibility shim. The ported canvas-panel calls
 * `createEditorOptions('code', overrides)` to build Monaco options;
 * cognia-next routes that through the canvas-settings store so user
 * preferences (font, wrap, minimap, etc.) flow through unchanged.
 */

import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"

export type EditorKind = "code" | "document"

export interface EditorOptionOverrides {
  language?: string
  readOnly?: boolean
  /** Pass-through Monaco options that the caller wants to layer on top. */
  [key: string]: unknown
}

export function createEditorOptions(
  kind: EditorKind,
  overrides: EditorOptionOverrides = {}
): Record<string, unknown> {
  const opts = useCanvasSettingsStore.getState().getEditorOptions()
  return {
    ...opts,
    // Documents wrap; code does not by default.
    wordWrap: kind === "document" ? "on" : opts.wordWrap,
    automaticLayout: true,
    ...overrides,
  }
}

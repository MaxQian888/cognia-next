/**
 * Canvas types barrel.
 *
 * `CanvasDocument`, `CanvasDocumentVersion`, `CanvasSuggestion`,
 * `CanvasEditorContext` etc. live in `@/types/artifact/artifact.ts`
 * (the existing artifact-store ports them). They are re-exported via
 * the top-level `@/types` barrel — import them from there. This file
 * only exposes the canvas-specific settings/panel/collaboration types
 * that don't have a home in the artifact module.
 */

export * from "./collaboration"
export * from "./panel"
export * from "./settings"
export * from "./symbols"

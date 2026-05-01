/**
 * Workflow types — definitions only.
 *
 * `workflow-editor` is intentionally not re-exported here: it pulls in
 * `@xyflow/react`, which cognia-next does not bundle (the visual editor
 * lives in Cognia). Downstream type consumers (e.g. `types/academic/ppt.ts`)
 * only need the data shapes from `./workflow`.
 */

export * from "./workflow"

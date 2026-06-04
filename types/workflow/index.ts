/**
 * Workflow types — definitions only.
 *
 * Two type families live here, each addressing a different concern:
 *
 *   • `./workflow` — the legacy higher-level WorkflowType / WorkflowDefinition
 *     used by PPT/report/document generation pipelines (consumed by
 *     `types/academic/ppt.ts`).
 *   • `./visual`   — the n8n-style visual graph editor + execution engine
 *     (consumed by `lib/workflow/`, `components/workflow/`, the new Settings
 *     section, and the Tauri-side trigger daemons).
 *
 * The two families intentionally share zero type names; the only collision
 * candidate (`WorkflowDefinition`) is reserved for the legacy file, and the
 * visual graph's top-level shape is exported as `VisualWorkflow`.
 */

export * from "./workflow"
export * from "./visual"
export * from "./conditions"

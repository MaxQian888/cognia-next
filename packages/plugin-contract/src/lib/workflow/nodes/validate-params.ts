/**
 * The plugin contract's share of `lib/workflow/nodes/validate-params.ts`, which re-exports these.
 */
/**
 * Per-field failure. The `key` is an i18n message key under
 * `workflows.validation.*`. The `params` carries any interpolation values
 * (e.g., `{ min: 1 }`) the message needs.
 */
export interface FieldError {
  key: string
  params?: Record<string, string | number>
}

export interface NodeValidationResult {
  /** Per-field errors, keyed by the dotted JSON path (e.g., `"cron"`). */
  fields: Record<string, FieldError>
  /** Flat list, useful for toast / save-blocked banner. */
  summary: string[]
  /** Convenience flag — `true` iff `fields` has any entry. */
  hasErrors: boolean
}

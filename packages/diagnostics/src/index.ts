/**
 * `@cognia/diagnostics` — the shared diagnostic vocabulary.
 *
 * Zero runtime dependencies and zero `@/` imports, so `lib/`, `packages/*` and
 * the CLI can all describe a failure the same way without dragging the app
 * graph (or React, or an icon set) along with them.
 */

export type {
  CogniaDiagnostic,
  DiagnosticAction,
  DiagnosticActionKind,
  DiagnosticCode,
  DiagnosticCodeSpec,
  DiagnosticIcon,
  DiagnosticMeta,
  DiagnosticSeverity,
  DiagnosticSource,
} from "./types"

export { DIAGNOSTIC_CODES, DIAGNOSTIC_CODE_IDS, isDiagnosticCode, specForCode } from "./registry"

export {
  createDiagnostic,
  __resetDiagnosticSequenceForTesting,
  type CreateDiagnosticInit,
} from "./create"

export {
  DIAGNOSTIC_ACTION_KINDS,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SOURCES,
  actionI18nKey,
  sourceI18nKey,
} from "./i18n-keys"

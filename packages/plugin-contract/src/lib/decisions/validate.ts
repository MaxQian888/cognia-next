/**
 * The plugin contract's share of `lib/decisions/validate.ts`, which re-exports these.
 */
import type { DecisionRequest } from "../../types/decisions/index"

export type DecisionValidation =
  { ok: true; request: DecisionRequest } | { ok: false; message: string }

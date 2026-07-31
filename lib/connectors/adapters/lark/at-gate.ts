/**
 * Re-export shim. The gate is now platform-agnostic and lives under
 * `lib/connectors/at-gate.ts`. Kept at this path because the original
 * Lark dispatcher + UI sub-cards + tests import from here.
 */

export {
  DEFAULT_AT_RESPONSE_STRATEGY,
  DEFAULT_BOT_INTERPLAY_BUDGET,
  shouldRespondToMessage,
  type AtGateDecision,
  type AtGateReason,
  type AtResponseStrategy,
} from "@/lib/connectors/at-gate"

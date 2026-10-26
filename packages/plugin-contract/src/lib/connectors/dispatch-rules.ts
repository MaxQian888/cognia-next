/**
 * The plugin contract's share of `lib/connectors/dispatch-rules.ts`, which re-exports these.
 */
import type { DispatchRule, DispatchRuleAction } from "../db/connector-types"

export interface DispatchRuleHit {
  rule: DispatchRule
  action: DispatchRuleAction
}

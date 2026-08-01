/**
 * The load-bearing guard of ADR-0102.
 *
 * `packages/agent-config-types/src/action-review.ts` must stay free of `@/`
 * imports so the CLI and any future zero-dep consumer can read the contract.
 * The cost of that is three RESTATED vocabularies — verdict, tier, and risk
 * surface — that duplicate `lib/claude/permissions/ruleset.ts` and
 * `lib/policy/risk/*`.
 *
 * This test is what makes the duplication safe. It pins the restatements both
 * ways: at compile time (the unions are mutually assignable, so adding a member
 * to one and not the other is a type error) and at runtime (the exported id
 * lists are set-equal, so a member added to both types but omitted from a
 * constant list is still caught).
 *
 * If this test fails, do NOT edit the expectation. Add the missing member to
 * whichever side is behind — the whole point is that the two cannot drift.
 */

import {
  ACTION_REVIEW_SURFACE_IDS,
  ACTION_REVIEW_TIERS,
  ACTION_REVIEW_VERDICTS,
  type ActionReviewSurfaceId,
  type ActionReviewTier,
  type ActionReviewVerdict,
} from "@cognia/agent-config-types/action-review"
import type { PermissionVerdict } from "@/lib/claude/permissions/ruleset"
import type { RiskTier } from "@/lib/policy/risk/classify-risk"
import { RISK_SURFACE_IDS, type RiskSurfaceId } from "@/lib/policy/risk/risk-surfaces"

describe("action-review contract parity", () => {
  describe("compile-time assignability", () => {
    // Each pair fails to compile if either union gains a member the other lacks.
    it("ActionReviewVerdict ↔ PermissionVerdict", () => {
      const toContract: ActionReviewVerdict = "allow" as PermissionVerdict
      const toLib: PermissionVerdict = "allow" as ActionReviewVerdict
      expect([toContract, toLib]).toEqual(["allow", "allow"])
    })

    it("ActionReviewTier ↔ RiskTier", () => {
      const toContract: ActionReviewTier = "low" as RiskTier
      const toLib: RiskTier = "low" as ActionReviewTier
      expect([toContract, toLib]).toEqual(["low", "low"])
    })

    it("ActionReviewSurfaceId ↔ RiskSurfaceId", () => {
      const toContract: ActionReviewSurfaceId = "external-send" as RiskSurfaceId
      const toLib: RiskSurfaceId = "external-send" as ActionReviewSurfaceId
      expect([toContract, toLib]).toEqual(["external-send", "external-send"])
    })
  })

  describe("runtime set-equality", () => {
    it("surface ids match RISK_SURFACE_IDS", () => {
      expect([...ACTION_REVIEW_SURFACE_IDS].sort()).toEqual([...RISK_SURFACE_IDS].sort())
    })

    // RiskTier and PermissionVerdict have no exported id list in lib/, so pin
    // the contract's lists literally. A member added to the lib union is caught
    // by the assignability block above; this catches a member added to the
    // contract type but forgotten in its constant.
    it("verdicts are exactly the ruleset's three", () => {
      expect([...ACTION_REVIEW_VERDICTS].sort()).toEqual(["allow", "ask", "deny"])
    })

    it("tiers are exactly the classifier's three", () => {
      expect([...ACTION_REVIEW_TIERS].sort()).toEqual(["high", "low", "medium"])
    })
  })
})

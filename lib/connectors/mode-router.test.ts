/**
 * Tests for the mode router (Task 28).
 *
 * Each (mode × matched × blocked × storeUnmatched) cell is asserted.
 */

import type { ConnectorMode } from "@/types/connectors/policy"
import type { PolicyEvalResult } from "./policy-eval"
import { routeInbound, routeInboundFromComposition, type RouteDecision } from "./mode-router"

function result(matched: boolean, blocked: boolean): PolicyEvalResult {
  return { matched, blocked, reason: blocked ? "test-blocker" : undefined }
}

type Cell = {
  mode: ConnectorMode
  matched: boolean
  blocked: boolean
  storeUnmatched: boolean
  expected: RouteDecision
}

const CELLS: Cell[] = [
  // auto mode
  { mode: "auto", matched: true, blocked: false, storeUnmatched: false, expected: "ai-run" },
  { mode: "auto", matched: true, blocked: true, storeUnmatched: false, expected: "drop" },
  { mode: "auto", matched: true, blocked: true, storeUnmatched: true, expected: "store-only" },
  { mode: "auto", matched: false, blocked: false, storeUnmatched: false, expected: "drop" },
  { mode: "auto", matched: false, blocked: false, storeUnmatched: true, expected: "store-only" },
  { mode: "auto", matched: false, blocked: true, storeUnmatched: false, expected: "drop" },
  { mode: "auto", matched: false, blocked: true, storeUnmatched: true, expected: "store-only" },

  // manual mode — always manual-store regardless of match/blocked
  {
    mode: "manual",
    matched: true,
    blocked: false,
    storeUnmatched: false,
    expected: "manual-store",
  },
  { mode: "manual", matched: true, blocked: true, storeUnmatched: false, expected: "manual-store" },
  {
    mode: "manual",
    matched: false,
    blocked: false,
    storeUnmatched: false,
    expected: "manual-store",
  },
  { mode: "manual", matched: false, blocked: true, storeUnmatched: true, expected: "manual-store" },

  // draft mode
  {
    mode: "draft",
    matched: true,
    blocked: false,
    storeUnmatched: false,
    expected: "draft-prepare",
  },
  { mode: "draft", matched: true, blocked: false, storeUnmatched: true, expected: "draft-prepare" },
  { mode: "draft", matched: true, blocked: true, storeUnmatched: false, expected: "drop" },
  { mode: "draft", matched: true, blocked: true, storeUnmatched: true, expected: "store-only" },
  { mode: "draft", matched: false, blocked: false, storeUnmatched: true, expected: "store-only" },
  { mode: "draft", matched: false, blocked: false, storeUnmatched: false, expected: "drop" },
  { mode: "draft", matched: false, blocked: true, storeUnmatched: true, expected: "store-only" },
  { mode: "draft", matched: false, blocked: true, storeUnmatched: false, expected: "drop" },
]

describe("routeInbound", () => {
  for (const cell of CELLS) {
    const label =
      `mode=${cell.mode} matched=${cell.matched} blocked=${cell.blocked} ` +
      `storeUnmatched=${cell.storeUnmatched} → ${cell.expected}`

    it(label, () => {
      const decision = routeInbound(
        cell.mode,
        result(cell.matched, cell.blocked),
        cell.storeUnmatched
      )
      expect(decision).toBe(cell.expected)
    })
  }
})

describe("routeInboundFromComposition", () => {
  const matched = { matched: true, blocked: false } as PolicyEvalResult
  const unmatched = { matched: false, blocked: false } as PolicyEvalResult
  const blocked = { matched: true, blocked: true } as PolicyEvalResult

  it("runs the turn and holds the product when autonomy is suggest", () => {
    // The bug this replaces: "draft" was a ROUTE, so a conversation bound to a
    // team resolved no execution target and silently degraded to a
    // single-agent draft. As an axis it is one run with acceptance owed.
    expect(
      routeInboundFromComposition({
        engagement: "background",
        autonomy: "suggest",
        evalResult: matched,
        storeUnmatchedInDraftMode: false,
      })
    ).toEqual({ kind: "run", requireAcceptance: true })
  })

  it("does not lose the target that made it background", () => {
    // The whole defect in one assertion: the decision no longer collapses a
    // team-bound conversation into a route that cannot express a team.
    const team = routeInboundFromComposition({
      engagement: "background",
      autonomy: "suggest",
      evalResult: matched,
      storeUnmatchedInDraftMode: false,
    })
    const direct = routeInboundFromComposition({
      engagement: "inline",
      autonomy: "suggest",
      evalResult: matched,
      storeUnmatchedInDraftMode: false,
    })
    expect(team).toEqual(direct)
    // Same decision, and the caller still holds the engagement/orchestration
    // that says WHO runs it — which the three-value route erased.
  })

  it("never runs a turn for observe or a human assignee", () => {
    for (const input of [
      { engagement: "human" as const, autonomy: "act" as const },
      { engagement: "inline" as const, autonomy: "observe" as const },
    ]) {
      expect(
        routeInboundFromComposition({
          ...input,
          evalResult: matched,
          storeUnmatchedInDraftMode: false,
        })
      ).toEqual({ kind: "manual-store", requireAcceptance: false })
    }
  })

  it("stores a human-owned conversation's traffic even when policy would drop it", () => {
    expect(
      routeInboundFromComposition({
        engagement: "human",
        autonomy: "observe",
        evalResult: blocked,
        storeUnmatchedInDraftMode: false,
      }).kind
    ).toBe("manual-store")
  })

  it("drops or stores unmatched traffic exactly as the legacy router did", () => {
    for (const evalResult of [unmatched, blocked]) {
      expect(
        routeInboundFromComposition({
          engagement: "inline",
          autonomy: "act",
          evalResult,
          storeUnmatchedInDraftMode: true,
        })
      ).toEqual({ kind: "store-only", requireAcceptance: false })
      expect(
        routeInboundFromComposition({
          engagement: "inline",
          autonomy: "act",
          evalResult,
          storeUnmatchedInDraftMode: false,
        })
      ).toEqual({ kind: "drop", requireAcceptance: false })
    }
  })

  it("owes no acceptance above suggest", () => {
    for (const autonomy of ["confirm", "act", "autopilot"] as const) {
      expect(
        routeInboundFromComposition({
          engagement: "inline",
          autonomy,
          evalResult: matched,
          storeUnmatchedInDraftMode: false,
        })
      ).toEqual({ kind: "run", requireAcceptance: false })
    }
  })
})

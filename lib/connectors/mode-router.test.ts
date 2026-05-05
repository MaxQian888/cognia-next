/**
 * Tests for the mode router (Task 28).
 *
 * Each (mode × matched × blocked × storeUnmatched) cell is asserted.
 */

import type { ConnectorMode } from "@/types/connectors/policy"
import type { PolicyEvalResult } from "./policy-eval"
import { routeInbound, type RouteDecision } from "./mode-router"

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

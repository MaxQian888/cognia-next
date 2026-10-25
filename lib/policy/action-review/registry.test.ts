import { ACTION_REVIEW_CHANNELS } from "@cognia/agent-config-types/action-review"
import {
  DEFAULT_ACTION_REVIEW_ADAPTERS,
  __resetActionReviewChannelsForTesting,
  getActionReviewChannelAdapter,
  registerActionReviewChannel,
} from "./registry"

beforeEach(__resetActionReviewChannelsForTesting)

it("declares a projection for every channel the contract declares", () => {
  for (const channel of ACTION_REVIEW_CHANNELS) {
    expect(DEFAULT_ACTION_REVIEW_ADAPTERS[channel]).toBeDefined()
  }
  // And nothing extra, so a removed channel cannot linger here.
  expect(Object.keys(DEFAULT_ACTION_REVIEW_ADAPTERS).sort()).toEqual(
    [...ACTION_REVIEW_CHANNELS].sort()
  )
})

const RECEIPT_ONLY_CHANNELS = new Set([
  "connector-workflow",
  "connector-delivery",
  "browser-submission",
])

it("keeps the receipt-only channels receipt-only, per the contract", () => {
  // The contract calls them "receipt-only, never a waiter" — minting an
  // interrupt would invent a pending item nobody can answer. A planned
  // connector delivery is answered in the draft center instead (ADR-0239).
  expect(getActionReviewChannelAdapter("connector-workflow").interruptType).toBeNull()
  expect(getActionReviewChannelAdapter("connector-delivery").interruptType).toBeNull()
  // A held browser submission is asked on the dialog, the run's own approval
  // path or a parked approval, each with its own question (ADR-0239 phase 2b).
  expect(getActionReviewChannelAdapter("browser-submission").interruptType).toBeNull()
})

it("gives every other channel a run interrupt to park on", () => {
  for (const channel of ACTION_REVIEW_CHANNELS) {
    if (RECEIPT_ONLY_CHANNELS.has(channel)) continue
    expect(getActionReviewChannelAdapter(channel).interruptType).not.toBeNull()
  }
})

it("lets a channel override its projection", () => {
  const adapter = { interruptType: "human_handoff" as const, defaultTtlMs: 5 }
  registerActionReviewChannel("chat-tool", adapter)
  expect(getActionReviewChannelAdapter("chat-tool")).toBe(adapter)
})

it("restores the default when the override is unregistered", () => {
  const unregister = registerActionReviewChannel("chat-tool", {
    interruptType: "human_handoff",
    defaultTtlMs: 5,
  })
  unregister()
  expect(getActionReviewChannelAdapter("chat-tool")).toBe(
    DEFAULT_ACTION_REVIEW_ADAPTERS["chat-tool"]
  )
})

it("does not let a stale unregister clobber a newer override", () => {
  const unregisterFirst = registerActionReviewChannel("chat-tool", {
    interruptType: "human_handoff",
    defaultTtlMs: 5,
  })
  const second = { interruptType: "plan_approval" as const, defaultTtlMs: 7 }
  registerActionReviewChannel("chat-tool", second)

  unregisterFirst()
  expect(getActionReviewChannelAdapter("chat-tool")).toBe(second)
})

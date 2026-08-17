/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

const mockUseLiveQuery = jest.fn()
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockUseLiveQuery(),
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import {
  useConversationActivity,
  isActivityKind,
  ACTIVITY_KINDS,
} from "./use-conversation-activity"

describe("isActivityKind", () => {
  it("accepts curated system-event kinds", () => {
    expect(isActivityKind("inbound.edited")).toBe(true)
    expect(isActivityKind("inbound.member_added")).toBe(true)
    expect(isActivityKind("inbound.reaction_added")).toBe(true)
    expect(isActivityKind("inbound.reaction_removed")).toBe(true)
    expect(isActivityKind("inbound.poke")).toBe(true)
    expect(isActivityKind("inbound.request")).toBe(true)
    expect(isActivityKind("inbound.lifecycle")).toBe(true)
    expect(isActivityKind("override.computer_use_changed")).toBe(true)
  })

  it("accepts the silent-reply diagnostic kinds (why no reply)", () => {
    expect(isActivityKind("inbound.policy_blocked")).toBe(true)
    expect(isActivityKind("inbound.deferred_manual_mode")).toBe(true)
    expect(isActivityKind("delivery.error")).toBe(true)
    expect(isActivityKind("delivery.deadlettered")).toBe(true)
    expect(isActivityKind("plugin.inbound_blocked")).toBe(true)
    expect(isActivityKind("plugin.rate_blocked")).toBe(true)
    expect(isActivityKind("plugin.transform_pii_blocked")).toBe(true)
    expect(isActivityKind("notify.im_pii_blocked")).toBe(true)
    expect(isActivityKind("workflow.dispatched")).toBe(true)
    expect(isActivityKind("team.dispatched")).toBe(true)
  })

  it("rejects non-activity kinds", () => {
    expect(isActivityKind("inbound.received")).toBe(false)
    expect(isActivityKind("delivery.success")).toBe(false)
    expect(isActivityKind("adapter.heartbeat")).toBe(false)
  })

  it("surfaces the SLA escalation kinds", () => {
    expect(isActivityKind("sla.escalated")).toBe(true)
    expect(isActivityKind("sla.escalation_action_failed")).toBe(true)
  })

  it("covers exactly the 29 curated kinds", () => {
    expect(ACTIVITY_KINDS.size).toBe(29)
  })
})

describe("useConversationActivity", () => {
  it("returns the live-queried entries", () => {
    const rows = [{ id: "e1", kind: "inbound.edited", at: 5 }]
    mockUseLiveQuery.mockReturnValue(rows)
    const { result } = renderHook(() => useConversationActivity("ck"))
    expect(result.current).toBe(rows)
  })

  it("falls back to an empty array before the query resolves", () => {
    mockUseLiveQuery.mockReturnValue(undefined)
    const { result } = renderHook(() => useConversationActivity("ck"))
    expect(result.current).toEqual([])
  })
})

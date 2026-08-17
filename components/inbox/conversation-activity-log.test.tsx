/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

beforeAll(() => {
  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    })
  }
})

import { ConversationActivityNotice } from "./conversation-activity-log"
import type { AuditEntry } from "@/types/connectors/audit"
import type { ConversationAssignmentEventRow } from "@/lib/db/crm-types"

const ENTRIES = [
  { id: "e1", kind: "inbound.edited", at: 1_700_000_000_000, adapterId: "a1" },
  { id: "e2", kind: "inbound.member_added", at: 1_700_000_001_000, adapterId: "a1" },
] as unknown as AuditEntry[]

// The two Dexie queries live in `useConversationActivity` /
// `useConversationAssignmentEvents` and are pinned by their own suites; this
// component is handed both lists to interleave and present.
function show(
  auditEntries: unknown[] = ENTRIES,
  assignmentEvents: unknown[] = []
): ReturnType<typeof render> {
  return render(
    <ConversationActivityNotice
      auditEntries={auditEntries as AuditEntry[]}
      assignmentEvents={assignmentEvents as ConversationAssignmentEventRow[]}
    />
  )
}

describe("ConversationActivityNotice", () => {
  it("renders nothing when there is no activity", () => {
    const { container } = show([], [])
    expect(container).toBeEmptyDOMElement()
  })

  it("interleaves assignment-trail events with audit rows", () => {
    show(
      [],
      [
        { id: "as1", conversationKey: "ck", kind: "assigned", at: 1_700_000_002_000 },
        { id: "as2", conversationKey: "ck", kind: "status.resolved", at: 1_700_000_003_000 },
      ]
    )
    expect(screen.getByTestId("activity-row-as1")).toHaveTextContent("Assigned")
    expect(screen.getByTestId("activity-row-as2")).toHaveTextContent("Resolved")
  })

  it("labels gesture-class platform events (reaction / poke / request / lifecycle)", () => {
    show(
      [
        { id: "g1", kind: "inbound.reaction_added", at: 1_700_000_000_000, adapterId: "a1" },
        { id: "g2", kind: "inbound.reaction_removed", at: 1_700_000_001_000, adapterId: "a1" },
        { id: "g3", kind: "inbound.poke", at: 1_700_000_002_000, adapterId: "a1" },
        { id: "g4", kind: "inbound.request", at: 1_700_000_003_000, adapterId: "a1" },
        { id: "g5", kind: "inbound.lifecycle", at: 1_700_000_004_000, adapterId: "a1" },
      ],
      []
    )
    expect(screen.getByTestId("activity-row-g1")).toHaveTextContent("Reaction added")
    expect(screen.getByTestId("activity-row-g2")).toHaveTextContent("Reaction removed")
    expect(screen.getByTestId("activity-row-g3")).toHaveTextContent("Poke")
    expect(screen.getByTestId("activity-row-g4")).toHaveTextContent("Join / friend request")
    expect(screen.getByTestId("activity-row-g5")).toHaveTextContent("Bot lifecycle event")
  })

  it("sorts the merged timeline newest-first across both sources", () => {
    show(
      [{ id: "e1", kind: "inbound.edited", at: 1_700_000_000_000, adapterId: "a1" }],
      [{ id: "as1", conversationKey: "ck", kind: "assigned", at: 1_700_000_005_000 }]
    )
    const rows = screen.getAllByTestId(/^activity-row-/)
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "activity-row-as1",
      "activity-row-e1",
    ])
  })

  // Disclosure moved to `InboxNoticeArea`, which owns the count across all
  // five notice sources — this one only reports its own.
  it("states the event count and no longer owns a toggle", () => {
    show()
    expect(screen.getByTestId("conversation-activity-log")).toHaveTextContent("2 events")
    expect(screen.queryByTestId("activity-log-toggle")).not.toBeInTheDocument()
  })

  it("shows one row per event with translated labels", () => {
    show()
    expect(screen.getByTestId("activity-log-list")).toBeInTheDocument()
    expect(screen.getByTestId("activity-row-e1")).toHaveTextContent("Message edited")
    expect(screen.getByTestId("activity-row-e2")).toHaveTextContent("Member joined")
  })

  it("labels the chat-management kinds (W2 multi-bot)", () => {
    show([
      { id: "c1", kind: "conversation.created", at: 1_700_000_010_000, adapterId: "a1" },
      { id: "c2", kind: "broadcast.enqueued", at: 1_700_000_011_000, adapterId: "a1" },
      { id: "c3", kind: "broadcast.partial_failure", at: 1_700_000_012_000, adapterId: "a1" },
    ])
    expect(screen.getByTestId("activity-row-c1")).toHaveTextContent("Conversation created")
    expect(screen.getByTestId("activity-row-c2")).toHaveTextContent("Broadcast enqueued")
    expect(screen.getByTestId("activity-row-c3")).toHaveTextContent("Broadcast partially failed")
  })

  it("labels the task-dispatch kind (W4)", () => {
    show([{ id: "t1", kind: "task.dispatched", at: 1_700_000_013_000, adapterId: "a1" }])
    expect(screen.getByTestId("activity-row-t1")).toHaveTextContent("Task dispatched")
  })

  it("labels the sibling-bot guard + team-posting kinds (W5)", () => {
    show([
      { id: "w1", kind: "inbound.sibling_bot_ignored", at: 1_700_000_014_000, adapterId: "a1" },
      {
        id: "w2",
        kind: "inbound.sibling_bot_budget_exhausted",
        at: 1_700_000_015_000,
        adapterId: "a1",
      },
      { id: "w3", kind: "team.posted_as_bot", at: 1_700_000_016_000, adapterId: "a1" },
    ])
    expect(screen.getByTestId("activity-row-w1")).toHaveTextContent("Sibling bot message ignored")
    expect(screen.getByTestId("activity-row-w2")).toHaveTextContent(
      "Sibling bot reply budget exhausted"
    )
    expect(screen.getByTestId("activity-row-w3")).toHaveTextContent("Team posted as bot")
  })

  it("falls back to the raw kind for an unmapped audit kind", () => {
    show([{ id: "e9", kind: "some.unmapped.kind", at: 1_700_000_009_000, adapterId: "a1" }])
    expect(screen.getByTestId("activity-row-e9")).toHaveTextContent("some.unmapped.kind")
  })

  it("labels a silent-reply diagnostic kind and appends its reason", () => {
    show([
      {
        id: "e3",
        kind: "inbound.policy_blocked",
        reason: "at_mention_required",
        at: 1_700_000_004_000,
        adapterId: "a1",
      },
    ])
    const row = screen.getByTestId("activity-row-e3")
    expect(row).toHaveTextContent("Blocked by policy")
    expect(row).toHaveTextContent("at_mention_required")
  })
})

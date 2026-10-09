/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@/components/interactions/test-pointer-polyfill"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DraftApprovalPanel } from "./draft-approval-panel"
import { createDraft, listAllPendingDrafts } from "@/lib/db/connector-drafts"
import { listAll, listByStatus } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { INBOX_RELAY_HOST_OPERATIONS } from "@/lib/platform/host-feature-manifest"

// The global next-intl mock resolves keys against the English bundle; its
// formatter prints ISO strings, which is what the relative-time check reads.

beforeEach(async () => {
  setActiveRuntimeTargetContext("acct_draft", "mobile-draft-test")
  // ADR-0131: the panel now writes through `lib/connectors/inbox-writes`,
  // which refuses on an unpaired shell. Model a real paired phone — a
  // companion target whose host advertises the relay and has granted this
  // device `workspace.write` — so the assertions below exercise the actual
  // relay path into `mobileOutboundQueue` rather than a mocked seam.
  setRuntimeSnapshot({
    target: {
      kind: "companion",
      id: "mobile-draft-test",
      hostKind: "desktop",
      platform: "mobile",
    },
    vaultState: "unlocked",
    connectionState: "online",
    host: {
      compatible: true,
      operations: [...INBOX_RELAY_HOST_OPERATIONS],
      grants: ["workspace.write"],
    },
  })
  // Clear Dexie tables.
  const db = getDb()
  await db.connectorDrafts.clear()
  for (const r of await listAll()) await db.mobileOutboundQueue.delete(r.id)
})

afterEach(() => {
  clearActiveRuntimeTargetContext()
  setRuntimeSnapshot({ target: null, vaultState: "unlocked", connectionState: "online" })
})

describe("<DraftApprovalPanel />", () => {
  it("shows a loading skeleton, not the empty state, before the first read lands", () => {
    render(<DraftApprovalPanel />)
    expect(screen.getByTestId("draft-approval-loading")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByTestId("draft-approval-empty")).not.toBeInTheDocument()
  })

  it("renders the empty state when no drafts pending", async () => {
    render(<DraftApprovalPanel />)
    expect(await screen.findByTestId("draft-approval-empty")).toBeInTheDocument()
  })

  it("lists pending drafts from Dexie", async () => {
    const draft = await createDraft({
      conversationKey: "telegram:chat-1",
      sessionId: "session-1",
      segments: [{ type: "text", text: "Hello there" }],
    })
    render(<DraftApprovalPanel />)
    expect(await screen.findByTestId(`draft-row-${draft.id}`)).toBeInTheDocument()
    expect(screen.getByText("Hello there")).toBeInTheDocument()
  })

  it("names the conversation, its platform and when the draft was written", async () => {
    await getDb().sessions.put({
      id: "session-t",
      title: "Acme support",
      createdAt: 1,
      updatedAt: 1,
      platformBinding: {
        adapterId: "a1",
        conversationKey: "telegram:a1:chat-9",
        platform: "telegram",
      },
    } as never)
    const draft = await createDraft({
      conversationKey: "telegram:a1:chat-9",
      sessionId: "session-t",
      segments: [{ type: "text", text: "Hi" }],
    })
    render(<DraftApprovalPanel />)
    expect(await screen.findByTestId(`draft-title-${draft.id}`)).toHaveTextContent("Acme support")
    expect(screen.getByTestId(`draft-time-${draft.id}`)).toHaveAttribute(
      "dateTime",
      new Date(draft.createdAt).toISOString()
    )
    // Flat divided rows, not cards.
    expect(screen.getByTestId(`draft-row-${draft.id}`).closest('[data-slot="card"]')).toBeNull()
    await getDb().sessions.delete("session-t")
  })

  it("falls back to the conversation key when no session names it", async () => {
    const draft = await createDraft({
      conversationKey: "lark:a2:room",
      sessionId: "s",
      segments: [{ type: "text", text: "Hi" }],
    })
    render(<DraftApprovalPanel />)
    expect(await screen.findByTestId(`draft-title-${draft.id}`)).toHaveTextContent("lark:a2:room")
  })

  it("does not send on a single tap: Approve asks first, and Cancel keeps the draft", async () => {
    const draft = await createDraft({
      conversationKey: "x",
      sessionId: "s",
      segments: [{ type: "text", text: "Hold on" }],
    })
    const user = userEvent.setup()
    render(<DraftApprovalPanel />)
    await user.click(await screen.findByTestId(`draft-approve-${draft.id}`))
    expect(await screen.findByTestId(`draft-approve-confirm-${draft.id}`)).toHaveTextContent(
      "Hold on"
    )
    await user.click(screen.getByTestId("draft-approve-cancel"))
    expect(await listAllPendingDrafts()).toHaveLength(1)
    expect(await listByStatus("pending")).toHaveLength(0)
  })

  it("approves a draft once the send is confirmed", async () => {
    const draft = await createDraft({
      conversationKey: "x",
      sessionId: "s",
      segments: [{ type: "text", text: "Confirm send" }],
    })
    const user = userEvent.setup()
    render(<DraftApprovalPanel />)
    await user.click(await screen.findByTestId(`draft-approve-${draft.id}`))
    await user.click(await screen.findByTestId("draft-approve-confirm"))
    await waitFor(async () => {
      const pending = await listAllPendingDrafts()
      expect(pending).toHaveLength(0)
    })
    const queued = await listByStatus("pending")
    expect(queued.find((q) => q.command === "connector_approve_draft")).toBeDefined()
  })

  it("rejects a draft when its reject button is tapped", async () => {
    const draft = await createDraft({
      conversationKey: "x",
      sessionId: "s",
      segments: [{ type: "text", text: "Maybe not" }],
    })
    const user = userEvent.setup()
    render(<DraftApprovalPanel />)
    await user.click(await screen.findByTestId(`draft-reject-${draft.id}`))
    await waitFor(async () => {
      expect(await listAllPendingDrafts()).toHaveLength(0)
    })
    const queued = await listByStatus("pending")
    expect(queued.find((q) => q.command === "connector_reject_draft")).toBeDefined()
  })

  it("opens the shared draft editor in a drawer from Edit", async () => {
    const draft = await createDraft({
      conversationKey: "x",
      sessionId: "s",
      segments: [{ type: "text", text: "Edit me" }],
    })
    const user = userEvent.setup()
    render(<DraftApprovalPanel />)
    await user.click(await screen.findByTestId(`draft-edit-${draft.id}`))
    const drawer = await screen.findByTestId("draft-edit-drawer")
    expect(drawer).toHaveTextContent("Edit reply to x")
    expect(screen.getByTestId("draft-segment-text-0")).toHaveValue("Edit me")
    // vaul's pointer handlers need a real layout engine; a click is enough here.
    fireEvent.click(screen.getByTestId("draft-cancel-btn"))
    await waitFor(() =>
      expect(screen.queryByTestId("draft-edit-drawer")).not.toBeInTheDocument()
    )
    expect(await listAllPendingDrafts()).toHaveLength(1)
  })

  it("falls back to a kind label when there is no text segment", async () => {
    const draft = await createDraft({
      conversationKey: "x",
      sessionId: "s",
      segments: [{ type: "image", url: "blob:img" }],
    })
    render(<DraftApprovalPanel />)
    expect(await screen.findByTestId(`draft-row-${draft.id}`)).toBeInTheDocument()
    expect(screen.getByText("[image]")).toBeInTheDocument()
  })

  it("summarizes markdown segments using the `md` field", async () => {
    const draft = await createDraft({
      conversationKey: "x",
      sessionId: "s",
      segments: [{ type: "markdown", md: "# Heading body" }],
    })
    render(<DraftApprovalPanel />)
    expect(await screen.findByTestId(`draft-row-${draft.id}`)).toBeInTheDocument()
    expect(screen.getByText("# Heading body")).toBeInTheDocument()
  })

  it("survives pull-to-refresh sweeping expired drafts", async () => {
    await createDraft({
      conversationKey: "x",
      sessionId: "s",
      segments: [{ type: "text", text: "Stale" }],
      expiresAt: Date.now() - 10_000,
    })
    render(<DraftApprovalPanel />)
    const wrap = await screen.findByTestId("pull-to-refresh")
    fireEvent.pointerDown(wrap, { clientX: 0, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(wrap, { clientX: 0, clientY: 200, pointerId: 1 })
    fireEvent.pointerUp(wrap, { clientX: 0, clientY: 200, pointerId: 1 })
    await waitFor(async () => {
      expect(await listAllPendingDrafts()).toHaveLength(0)
    })
  })
})

/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@/components/mobile/interactions/test-pointer-polyfill"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DraftApprovalPanel } from "./draft-approval-panel"
import { createDraft, listAllPendingDrafts } from "@/lib/db/connector-drafts"
import { listAll, listByStatus } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      empty: "No drafts pending approval.",
      approve: "Approve",
      reject: "Reject",
      queueLabelApprove: "Approve connector draft",
      queueLabelReject: "Reject connector draft",
    }
    return map[key] ?? key
  },
}))

beforeEach(async () => {
  // Clear Dexie tables.
  const db = getDb()
  await db.connectorDrafts.clear()
  for (const r of await listAll()) await db.mobileOutboundQueue.delete(r.id)
})

describe("<DraftApprovalPanel />", () => {
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

  it("approves a draft when its approve button is tapped", async () => {
    const draft = await createDraft({
      conversationKey: "x",
      sessionId: "s",
      segments: [{ type: "text", text: "Confirm send" }],
    })
    const user = userEvent.setup()
    render(<DraftApprovalPanel />)
    await user.click(await screen.findByTestId(`draft-approve-${draft.id}`))
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

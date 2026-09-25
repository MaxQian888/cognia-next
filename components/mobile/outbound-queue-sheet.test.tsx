/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en.json"
import {
  claimNext,
  enqueue,
  enqueueHostStateAction,
  recordFailure,
} from "@/lib/db/mobile-outbound-queue"
import { __resetDbForTesting, activateAccountDatabase, getDb } from "@/lib/db/schema"
import { setActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { __resetRuntimeSnapshotForTesting } from "@/lib/runtime/runtime-snapshot-store"

import { OutboundQueueSheet } from "./outbound-queue-sheet"

const toastSuccess = jest.fn()
const toastMessage = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    message: (...a: unknown[]) => toastMessage(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

const scope = { accountId: "acct_sheet", targetId: "desktop-studio", routingGeneration: 1 }

function renderSheet() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} now={new Date(10_000)}>
      <OutboundQueueSheet open onOpenChange={jest.fn()} />
    </NextIntlClientProvider>
  )
}

beforeEach(async () => {
  jest.clearAllMocks()
  activateAccountDatabase(scope.accountId, scope.targetId)
  await getDb().delete()
  __resetDbForTesting()
  activateAccountDatabase(scope.accountId, scope.targetId)
  setActiveRuntimeTargetContext(scope.accountId, scope.targetId)
  __resetRuntimeSnapshotForTesting()
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("OutboundQueueSheet", () => {
  it("says so when nothing is queued", async () => {
    renderSheet()
    expect(await screen.findByTestId("outbound-queue-empty")).toHaveTextContent(
      "Nothing is queued."
    )
  })

  it("lists a queued action by its label and withdraws it", async () => {
    const row = await enqueue({
      command: "workflow_trigger_manual",
      payload: {},
      label: "Trigger workflow Daily Digest",
      ...scope,
      nowMs: 1,
    })
    renderSheet()
    const item = await screen.findByTestId(`outbound-queue-row-${row.id}`)
    expect(item).toHaveTextContent("Trigger workflow Daily Digest")
    expect(item).toHaveTextContent("Waiting to send")
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toBeUndefined()
    expect(await screen.findByTestId("outbound-queue-empty")).toBeInTheDocument()
  })

  it("offers nothing to take back once a row is sending", async () => {
    const row = await enqueue({ command: "connector_send", payload: {}, ...scope, nowMs: 1 })
    await claimNext(1, scope)
    renderSheet()
    const item = await screen.findByTestId(`outbound-queue-row-${row.id}`)
    expect(item).toHaveAttribute("data-status", "sending")
    expect(item.querySelector("button")).toBeNull()
  })

  it("keeps a conversation send in order instead of offering to withdraw it", async () => {
    const row = await enqueueHostStateAction({
      channel: "cognia://target/desktop-studio/sessions/s1",
      accountId: scope.accountId,
      runtimeTargetId: scope.targetId,
      hostId: scope.targetId,
      hostGeneration: 2,
      sessionId: "s1",
      clientId: "client-a",
      clientSeq: 1,
      actionId: "action-1",
      baseRevision: 1,
      createdAt: 100,
      action: { kind: "draft.replace", text: "draft", attachments: [] },
    })
    renderSheet()
    const item = await screen.findByTestId(`outbound-queue-row-${row.id}`)
    expect(item).toHaveTextContent("sends in order")
    expect(item.querySelector("button")).toBeNull()
  })

  it("retries or discards a row that ran out of retries", async () => {
    const row = await enqueue({ command: "connector_send", payload: {}, ...scope, nowMs: 1 })
    await claimNext(1, scope)
    // Enough failures to exhaust the retry budget.
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await recordFailure({ id: row.id, error: "host said no", nowMs: 1 })
      if (status === "deadlettered") break
      await claimNext(Number.MAX_SAFE_INTEGER, scope)
    }
    await expect(getDb().mobileOutboundQueue.get(row.id)).resolves.toMatchObject({
      status: "deadlettered",
    })
    renderSheet()
    const item = await screen.findByTestId(`outbound-queue-row-${row.id}`)
    expect(item).toHaveTextContent("Gave up after retries")
    expect(item).toHaveTextContent("host said no")
    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    await waitFor(async () =>
      expect(await getDb().mobileOutboundQueue.get(row.id)).toBeUndefined()
    )
  })
})

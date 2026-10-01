/** @jest-environment jsdom */

import "fake-indexeddb/auto"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"

import { activateAccountDatabase, __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"

import { CollabConflictsPanel } from "./collab-conflicts-panel"

const row: MobileOutboundJobRow = {
  id: "op-1",
  accountId: "acct-1",
  targetId: "collab-plane",
  command: "collab_issue_patch",
  payload: { orgId: "org-1", issueId: "iss-1", operationId: "op-1", title: "Mine" },
  status: "conflicted",
  attempts: 1,
  createdAt: 1,
  nextAttemptAt: 1,
  idempotencyKey: "op-1",
  protocol: "collab-v1",
  conflictAuthoritative: { id: "iss-1", title: "Theirs", revision: 2 },
  currentRevision: 2,
}

beforeEach(async () => {
  activateAccountDatabase("acct-1", "collab-plane")
  await getDb().delete()
  __resetDbForTesting()
  activateAccountDatabase("acct-1", "collab-plane")
  await getDb().mobileOutboundQueue.put(row)
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("shows both versions and lets the user discard the pending patch", async () => {
  const user = userEvent.setup()
  render(<CollabConflictsPanel />)
  expect(await screen.findByText(/Theirs/)).toBeInTheDocument()
  expect(screen.getByText(/Mine/)).toBeInTheDocument()
  await user.click(screen.getByText("discard"))
  await waitFor(() =>
    expect(screen.queryByTestId("collab-conflicts-panel")).not.toBeInTheDocument()
  )
})

it("rebases only after the user requests it", async () => {
  const user = userEvent.setup()
  render(<CollabConflictsPanel />)
  await user.click(await screen.findByText("resubmit"))
  await waitFor(async () => {
    const rows = await getDb().mobileOutboundQueue.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "pending" })
    expect(rows[0]).not.toHaveProperty("currentRevision")
    expect(rows[0].payload).toMatchObject({ baseRevision: 2, title: "Mine" })
  })
})

it("names each clashing field, both values and who changed it (ADR-0208)", async () => {
  await getDb().users.put({ id: "usr_b", displayName: "Bea", createdAt: 1, updatedAt: 1 })
  await getDb().mobileOutboundQueue.put({
    ...row,
    id: "op-2",
    conflictFields: {
      status: { yours: "done", theirs: "todo", changedAt: 2, changedBy: "usr_b" },
      "steps.s1": { yours: null, theirs: "blocked", changedAt: 3, changedBy: null },
    },
  })
  render(<CollabConflictsPanel />)
  const status = await screen.findByTestId("conflict-field-op-2-status")
  expect(status).toHaveTextContent("field.status")
  expect(status).toHaveTextContent("done")
  expect(status).toHaveTextContent("todo")
  await waitFor(() => expect(status).toHaveTextContent('changedBy:{"name":"Bea","revision":2}'))
  const step = screen.getByTestId("conflict-field-op-2-steps.s1")
  expect(step).toHaveTextContent('field.step:{"id":"s1"}')
  expect(step).toHaveTextContent("emptyValue")
  expect(step).toHaveTextContent('changedByUnknown:{"revision":3}')
})

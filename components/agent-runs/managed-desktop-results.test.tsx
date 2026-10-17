import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}:${JSON.stringify(args)}` : key,
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: jest.fn((select) => select({ unlockedAccountId: "owner", locked: false })),
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => null,
  getActiveRemoteEndpoint: () => null,
  subscribeActiveRemoteTransport: () => () => undefined,
}))
jest.mock("@/hooks/agent-runs/use-managed-desktop-results", () => ({
  useManagedDesktopResults: jest.fn(),
}))
jest.mock("@/lib/execution/managed-desktop-results", () => ({
  managedDesktopAcceptanceRunId: (id: string) => `execution:managed-desktop:${id}`,
}))
import { ManagedDesktopResults } from "./managed-desktop-results"
import { useManagedDesktopResults } from "@/hooks/agent-runs/use-managed-desktop-results"
import { useAccountStore } from "@/stores/account/account-store"
const record = {
  binding: {
    acceptanceId: "a",
    commit: "sha",
    taskId: "task",
    parentRunId: "parent",
    sessionId: "session",
    originRunRef: "origin",
    criteria: [{ id: "c", text: "Check login" }],
  },
  artifacts: [{ id: "image", criterionId: "c", kind: "checkpoint", capturedAt: 1 }],
  agentVerdict: {
    input: {
      outcome: "passed",
      principalId: "agent",
      summary: "Verified",
      criteria: [{ criterionId: "c", outcome: "passed" }],
    },
    recordedAt: 1,
  },
  humanApprovals: [],
}
let state: Record<string, unknown>
beforeEach(() => {
  state = {
    records: [record],
    previews: {},
    error: false,
    loading: false,
    busy: false,
    viewEvidence: jest.fn(),
    approve: jest.fn(),
    remove: jest.fn(),
  }
  ;(useManagedDesktopResults as jest.Mock).mockImplementation(() => state)
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((select) =>
    select({ unlockedAccountId: "owner", locked: false })
  )
})
test("links source/child history and keeps independent human review separate from agent pass", async () => {
  render(<ManagedDesktopResults runId="parent" />)
  expect(screen.getByText(/agentVerdict/)).toHaveTextContent("outcome.passed")
  expect(screen.getByText("notReviewed")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "openRun" })).toHaveAttribute(
    "href",
    "/agent-runs?run=execution%3Amanaged-desktop%3Aa"
  )
  expect(screen.getByRole("link", { name: "openConversation" })).toHaveAttribute(
    "href",
    expect.stringContaining("session")
  )
  await userEvent.click(screen.getByRole("button", { name: "approve" }))
  expect(state.approve).toHaveBeenCalledWith(record, "approved")
  expect(screen.getByText("dormant")).toHaveAttribute(
    "data-dormant",
    "managed-desktop-acceptance-execution"
  )
})
test("screenshot fetch requires a click and exposes no share action", async () => {
  render(<ManagedDesktopResults taskId="task" />)
  expect(state.viewEvidence).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole("button", { name: /viewScreenshot/ }))
  expect(state.viewEvidence).toHaveBeenCalledWith(record, "image")
  expect(screen.queryByRole("button", { name: /share/i })).not.toBeInTheDocument()
})
test("system inconclusive is not shown as an agent verdict", () => {
  state.records = [
    { ...record, agentVerdict: null, systemOutcome: { outcome: "inconclusive", recordedAt: 2 } },
  ]
  render(<ManagedDesktopResults runId="parent" />)
  expect(screen.getByText("noAgentVerdict")).toBeInTheDocument()
  expect(screen.getByText(/systemOutcome/)).toHaveTextContent("outcome.inconclusive")
})
test("human rejection revisions coexist with an unchanged agent pass", () => {
  state.records = [
    {
      ...record,
      humanApprovals: [
        { revision: 1, input: { decision: "rejected", principalId: "human" }, recordedAt: 2 },
      ],
    },
  ]
  render(<ManagedDesktopResults runId="parent" />)
  expect(screen.getByText(/agentVerdict/)).toHaveTextContent("outcome.passed")
  expect(screen.getByText(/approval:/)).toHaveTextContent("decision.rejected")
})
test("locked accounts do not mount private history", () => {
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((select) =>
    select({ unlockedAccountId: "owner", locked: true })
  )
  render(<ManagedDesktopResults runId="parent" />)
  expect(screen.queryByRole("region")).not.toBeInTheDocument()
})

test("deleting acceptance requires confirmation before calling the canonical action", async () => {
  render(<ManagedDesktopResults runId="parent" />)
  await userEvent.click(screen.getByRole("button", { name: "delete" }))
  expect(state.remove).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole("button", { name: "deleteConfirm" }))
  expect(state.remove).toHaveBeenCalledWith(record)
})

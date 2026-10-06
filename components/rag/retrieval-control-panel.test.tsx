/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { RetrievalControlSnapshot } from "@/lib/db/retrieval-control"

const cancelJob = jest.fn<Promise<unknown>, [string]>()
const retryJob = jest.fn<Promise<unknown>, [string, { id: string }]>()
const setKillSwitch = jest.fn<Promise<void>, [unknown]>()

let snapshot: RetrievalControlSnapshot | undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => snapshot,
}))

jest.mock("@/lib/db/retrieval-control", () => ({
  cancelStoredRetrievalJob: (id: string) => cancelJob(id),
  listRetrievalControlSnapshot: jest.fn(),
  retryStoredRetrievalJob: (id: string, input: { id: string }) => retryJob(id, input),
  setRetrievalKillSwitch: (input: unknown) => setKillSwitch(input),
}))

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: object) => unknown) =>
    selector({ activeAccountId: "account-1", accountRevision: 1, locked: false }),
}))

jest.mock("@/lib/platform/detect", () => ({
  isCapacitor: () => false,
  isTauri: () => false,
}))

jest.mock("@/lib/runtime/browser-vault", () => ({
  getActiveBrowserVault: () => ({ isUnlocked: () => true }),
}))

import { RetrievalControlPanel } from "./retrieval-control-panel"

function controlSnapshot(
  overrides: Partial<RetrievalControlSnapshot> = {}
): RetrievalControlSnapshot {
  return {
    generations: [],
    jobs: [],
    traces: [],
    tombstones: [],
    migrations: [],
    runtime: { killSwitchEngaged: false },
    ...overrides,
  }
}

beforeEach(() => {
  cancelJob.mockReset().mockResolvedValue(undefined)
  retryJob.mockReset().mockResolvedValue(undefined)
  setKillSwitch.mockReset().mockResolvedValue(undefined)
  snapshot = controlSnapshot()
})

it("shows content-free generation, job, trace, and Vault status", () => {
  snapshot = controlSnapshot({
    generations: [
      {
        id: "generation-1",
        corpusId: "twin:1:source:a",
        domain: "twin",
        profileFingerprint: "fingerprint",
        status: "active",
        createdAt: 1,
      },
      {
        id: "generation-failed",
        corpusId: "twin:1:source:b",
        domain: "twin",
        profileFingerprint: "fingerprint",
        status: "failed",
        createdAt: 2,
      },
    ],
    jobs: [
      {
        id: "job-running",
        dedupeKey: "job-running",
        kind: "reindex",
        corpusId: "twin:1:source:a",
        status: "running",
        queuedAt: 3,
        attempt: 1,
        maxAttempts: 3,
      },
    ],
    traces: [{ traceId: "trace-1", createdAt: 4, expiresAt: 5 } as never],
  })

  render(<RetrievalControlPanel corpusPrefixes={["twin:1:"]} />)

  expect(screen.getByText("Retrieval control plane")).toBeTruthy()
  expect(screen.getByText("Vault unlocked")).toBeTruthy()
  expect(screen.getByText("generation-1")).toBeTruthy()
  expect(screen.getByText("job-running")).toBeTruthy()
  expect(screen.queryByText("trace-1")).toBeNull()
})

it("shows a loading state instead of reporting an empty control plane before data arrives", () => {
  snapshot = undefined
  render(<RetrievalControlPanel />)

  expect(screen.getByText("Loading retrieval state…")).toBeInTheDocument()
  expect(
    screen.queryByText("No retrieval generations or jobs are recorded for this scope.")
  ).not.toBeInTheDocument()
})

it("cancels active jobs and creates a new queued retry for terminal failures", async () => {
  snapshot = controlSnapshot({
    jobs: [
      {
        id: "job-running",
        dedupeKey: "job-running",
        kind: "reindex",
        corpusId: "project:1:file:a",
        status: "running",
        queuedAt: 3,
        attempt: 1,
        maxAttempts: 3,
      },
      {
        id: "job-failed",
        dedupeKey: "job-failed",
        kind: "reconcile",
        corpusId: "project:1:file:a",
        status: "failed",
        queuedAt: 2,
        attempt: 3,
        maxAttempts: 3,
      },
    ],
  })
  render(<RetrievalControlPanel corpusPrefixes={["project:1:"]} />)

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))

  await waitFor(() => expect(cancelJob).toHaveBeenCalledWith("job-running"))
  expect(retryJob).toHaveBeenCalledWith(
    "job-failed",
    expect.objectContaining({ id: expect.stringMatching(/^retrieval-job:/) })
  )
})

it("requires confirmation before engaging the kill switch", async () => {
  render(<RetrievalControlPanel />)
  fireEvent.click(screen.getByRole("button", { name: "Stop new retrieval work" }))
  expect(screen.getByText("Engage retrieval kill switch?")).toBeTruthy()

  fireEvent.click(screen.getByRole("button", { name: "Stop new retrieval work" }))
  await waitFor(() =>
    expect(setKillSwitch).toHaveBeenCalledWith(
      expect.objectContaining({
        engaged: true,
        changedBy: "user",
        reasonCode: "user_control_plane",
      })
    )
  )
})

it("recovers the kill-switch control and reports a failed request", async () => {
  setKillSwitch.mockRejectedValue(new Error("database unavailable"))
  render(<RetrievalControlPanel />)

  fireEvent.click(screen.getByRole("button", { name: "Stop new retrieval work" }))
  fireEvent.click(screen.getByRole("button", { name: "Stop new retrieval work" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("The retrieval control action failed.")
  expect(screen.getByRole("button", { name: "Stop new retrieval work" })).toBeEnabled()
})

it("sizes the metric grid and header actions from the panel rather than the viewport", () => {
  render(<RetrievalControlPanel />)
  const panel = screen.getByTestId("retrieval-control-panel")
  expect(panel).toHaveClass("@container/retrieval", "min-w-0")
  const metrics = screen.getByText("Active generations").parentElement?.parentElement
  expect(metrics).toHaveClass("@min-[360px]/retrieval:grid-cols-2", "@2xl/retrieval:grid-cols-4")
  expect(metrics).not.toHaveClass("lg:grid-cols-4")
  expect(screen.getByText("Vault unlocked").parentElement).toHaveClass(
    "@min-[640px]/retrieval:w-auto"
  )
})

it("keeps compact mode summary-only while retaining the shared controls", () => {
  snapshot = controlSnapshot({
    jobs: [
      {
        id: "compact-job",
        dedupeKey: "compact-job",
        kind: "reindex",
        corpusId: "memory:test",
        status: "running",
        queuedAt: 1,
        attempt: 1,
        maxAttempts: 3,
      },
    ],
  })
  render(<RetrievalControlPanel compact />)
  expect(screen.queryByText("compact-job")).not.toBeInTheDocument()
  expect(screen.queryByText("Recent jobs")).not.toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Stop new retrieval work" })).toBeEnabled()
  expect(screen.getByText("Active jobs")).toBeInTheDocument()
})

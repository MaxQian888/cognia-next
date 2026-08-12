/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createSession } from "@/lib/db/sessions"
import { createExecutionRun } from "@/lib/db/execution-runs"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { RunContextPanel } from "./run-context-panel"

describe("RunContextPanel", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    useArtifactStore.setState({ artifacts: {} })
  })

  it("lets the user mutate the same CAS-backed working set used by the agent tool", async () => {
    const user = userEvent.setup()
    const session = await createSession({ title: "Run context" })
    render(<RunContextPanel sessionId={session.id} />)

    const summary = await screen.findByRole("textbox", { name: "Working set summary" })
    fireEvent.change(summary, { target: { value: "Reuse the execution journal" } })
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByText("Reuse the execution journal")).toBeInTheDocument()
  }, 15_000)

  it("shows pending run learning in the Review tab badge", async () => {
    const user = userEvent.setup()
    const session = await createSession({ title: "Review" })
    await createExecutionRun({
      id: "run-1",
      kind: "agent-turn",
      sourceId: "turn-1",
      sessionId: session.id,
      title: "Chat run",
      status: "completed",
      currentRevision: 1,
      startedAt: 1,
      updatedAt: 2,
      endedAt: 2,
    })
    const db = getDb()
    await db.runRetrospectives.add({
      id: "retro-1",
      runId: "run-1",
      runKey: "run-1:1",
      analysisVersion: 1,
      status: "pending_review",
      issueTimeline: [],
      contentHash: "hash",
      createdAt: 2,
      updatedAt: 2,
    })
    await db.runLearningProposals.add({
      id: "proposal-1",
      retrospectiveId: "retro-1",
      runId: "run-1",
      targetKind: "observation",
      title: "Review the retry boundary",
      after: "No automatic action",
      status: "pending",
      evidenceRefs: [],
      createdAt: 2,
      updatedAt: 2,
    })

    render(<RunContextPanel sessionId={session.id} />)
    const reviewTab = await screen.findByRole("tab", { name: /Review/ })
    await waitFor(() => expect(reviewTab).toHaveTextContent("1"))
    await user.click(reviewTab)
    expect(await screen.findByText("Review the retry boundary")).toBeInTheDocument()
  }, 15_000)
})

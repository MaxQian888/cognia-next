/** @jest-environment jsdom */

import { StrictMode } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { EvalReportCaseEvidence } from "@/lib/ai/eval/report-view"
import type {
  EvalReviewService,
  EvalReviewSnapshot,
  EvalReviewMutationResult,
} from "@/lib/ai/eval/review-service"
import { BlindReviewPanel } from "./blind-review-panel"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/ai/eval/review-service", () => ({
  buildBlindReviewPairs: (cases: unknown[]) => (cases.length ? [{}] : []),
}))

const snapshot: EvalReviewSnapshot = {
  batchId: "batch-1",
  recommendationPending: false,
  assignments: [
    {
      assignmentId: "assignment-1",
      pairId: "case-1:1:a:b",
      left: { sampleId: "sample-a", output: "Left output" },
      right: { sampleId: "sample-b", output: "Right output" },
    },
  ],
  votes: [],
  agreement: { eligiblePairs: 0, agreedPairs: 0, agreementRate: 0 },
}
const updated: EvalReviewMutationResult = { snapshot, recommendation: { status: "updated" } }

function service(): jest.Mocked<EvalReviewService> {
  return {
    scopeId: "scope-1",
    load: jest.fn().mockResolvedValue(null),
    open: jest.fn().mockResolvedValue(snapshot),
    vote: jest.fn().mockResolvedValue(updated),
    exportBundle: jest.fn().mockResolvedValue('{"schema":"cognia-eval-review/v1"}'),
    importBundle: jest.fn().mockResolvedValue(updated),
    adjudicate: jest.fn().mockResolvedValue(updated),
    refreshRecommendation: jest.fn().mockResolvedValue(updated),
  }
}

function evidence(variantId: string, sampleId: string, output: string): EvalReportCaseEvidence {
  return {
    case: {
      id: "case-1",
      datasetId: "dataset",
      input: "Question",
      capability: "chat.qa",
      source: "handwritten",
      split: "test",
      createdAt: 1,
      updatedAt: 1,
    },
    sample: {
      output,
      latencyMs: 1,
      costUsd: 0,
      toolCalls: [],
      retrievedChunks: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stepCount: 0,
      degraded: false,
    },
    variantId,
    repetition: 1,
    sampleId,
    taskId: `task-${variantId}`,
    scores: [],
    status: "passed",
  }
}

const cases = [evidence("a", "sample-a", "A"), evidence("b", "sample-b", "B")]
const props = { experimentId: "experiment", cases, seed: 42 }

async function openPanel(
  runtime: EvalReviewService,
  onRecommendationChanged?: () => void | Promise<void>
) {
  const rendered = render(
    <BlindReviewPanel
      {...props}
      service={runtime}
      onRecommendationChanged={onRecommendationChanged}
    />
  )
  const create = screen.getByRole("button", { name: "lab.review.blind.create" })
  await waitFor(() => expect(create).toBeEnabled())
  fireEvent.click(create)
  await screen.findByText("Left output")
  return rendered
}

describe("BlindReviewPanel", () => {
  it("opens a service batch and sends only review intent", async () => {
    const runtime = service()
    const changed = jest.fn()
    await openPanel(runtime, changed)
    expect(runtime.open).toHaveBeenCalledWith(props)
    fireEvent.change(screen.getByLabelText("lab.review.blind.reviewer"), {
      target: { value: "reviewer-1" },
    })
    fireEvent.click(screen.getByRole("button", { name: "lab.review.blind.preferLeft" }))
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(runtime.vote).toHaveBeenCalledWith({
      experimentId: "experiment",
      batchId: "batch-1",
      pairId: "case-1:1:a:b",
      reviewerId: "reviewer-1",
      preference: "a",
    })
  })

  it("restores an existing batch when the panel opens", async () => {
    const runtime = service()
    runtime.load.mockResolvedValue(snapshot)
    render(<BlindReviewPanel {...props} service={runtime} />)
    await screen.findByText("Left output")
    expect(runtime.open).not.toHaveBeenCalled()
  })

  it("restores pending recommendation retry after remount", async () => {
    const runtime = service()
    runtime.load.mockResolvedValue({ ...snapshot, recommendationPending: true })
    render(<BlindReviewPanel {...props} service={runtime} />)
    await screen.findByText("lab.review.blind.refreshPending")
    fireEvent.click(screen.getByRole("button", { name: "lab.review.blind.retryRefresh" }))
    await waitFor(() => expect(runtime.refreshRecommendation).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.queryByText("lab.review.blind.refreshPending")).not.toBeInTheDocument()
    )
    expect(runtime.vote).not.toHaveBeenCalled()
  })

  it("disables review creation without an active service or comparison pairs", () => {
    render(<BlindReviewPanel {...props} cases={[]} service={null} />)
    expect(screen.getByRole("button", { name: "lab.review.blind.create" })).toBeDisabled()
    expect(screen.getByText("lab.review.blind.noPairs")).toBeInTheDocument()
  })

  it("blocks duplicate clicks and retries recommendation refresh without another vote", async () => {
    const runtime = service()
    let release!: (result: EvalReviewMutationResult) => void
    runtime.vote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const changed = jest.fn()
    await openPanel(runtime, changed)
    fireEvent.change(screen.getByLabelText("lab.review.blind.reviewer"), {
      target: { value: "reviewer" },
    })
    const vote = screen.getByRole("button", { name: "lab.review.blind.preferLeft" })
    fireEvent.click(vote)
    fireEvent.click(vote)
    expect(runtime.vote).toHaveBeenCalledTimes(1)
    await act(async () =>
      release({ snapshot, recommendation: { status: "pending", message: "refresh offline" } })
    )
    expect(screen.getByText("lab.review.blind.refreshPending")).toBeInTheDocument()
    expect(screen.getByText("refresh offline")).toBeInTheDocument()
    expect(changed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "lab.review.blind.retryRefresh" }))
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(runtime.refreshRecommendation).toHaveBeenCalledWith({
      experimentId: "experiment",
      batchId: "batch-1",
    })
    expect(runtime.vote).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("lab.review.blind.refreshPending")).not.toBeInTheDocument()
  })

  it("exports, imports and adjudicates through complete service operations", async () => {
    const runtime = service()
    const changed = jest.fn()
    const user = userEvent.setup()
    await openPanel(runtime, changed)
    await user.type(screen.getByLabelText("lab.review.blind.password"), "password")
    await user.click(screen.getByRole("button", { name: "lab.review.blind.export" }))
    expect(runtime.exportBundle).toHaveBeenCalledWith({
      experimentId: "experiment",
      batchId: "batch-1",
      password: "password",
    })
    await user.click(screen.getByRole("button", { name: "lab.review.blind.import" }))
    expect(runtime.importBundle).toHaveBeenCalledWith({
      experimentId: "experiment",
      batchId: "batch-1",
      password: "password",
      text: '{"schema":"cognia-eval-review/v1"}',
    })
    await user.type(screen.getByLabelText("lab.review.blind.adjudicator"), "lead")
    await user.type(screen.getByLabelText("lab.review.blind.reasoning"), "reference-aligned")
    await user.click(screen.getByRole("button", { name: "lab.review.blind.decisions.a" }))
    expect(runtime.adjudicate).toHaveBeenCalledWith({
      experimentId: "experiment",
      batchId: "batch-1",
      pairId: "case-1:1:a:b",
      adjudicatorId: "lead",
      decision: "a",
      reasoning: "reference-aligned",
    })
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it.each(["vote", "exportBundle", "importBundle", "adjudicate"] as const)(
    "surfaces %s failures without unhandled event promises",
    async (operation) => {
      const runtime = service()
      runtime[operation].mockRejectedValueOnce(new Error("operation failed"))
      await openPanel(runtime)
      fireEvent.change(screen.getByLabelText("lab.review.blind.reviewer"), {
        target: { value: "reviewer" },
      })
      fireEvent.change(screen.getByLabelText("lab.review.blind.password"), {
        target: { value: "password" },
      })
      fireEvent.change(screen.getByLabelText("lab.review.blind.bundle"), {
        target: { value: "{}" },
      })
      fireEvent.change(screen.getByLabelText("lab.review.blind.adjudicator"), {
        target: { value: "lead" },
      })
      const names = {
        vote: "preferLeft",
        exportBundle: "export",
        importBundle: "import",
        adjudicate: "decisions.a",
      }
      fireEvent.click(screen.getByRole("button", { name: `lab.review.blind.${names[operation]}` }))
      expect(await screen.findByText("operation failed")).toBeInTheDocument()
    }
  )

  it("discards old asynchronous results after experiment or host scope changes", async () => {
    const runtime = service()
    let release!: (value: EvalReviewSnapshot) => void
    runtime.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const { rerender } = render(<BlindReviewPanel {...props} service={runtime} />)
    const create = screen.getByRole("button", { name: "lab.review.blind.create" })
    await waitFor(() => expect(create).toBeEnabled())
    fireEvent.click(create)
    rerender(<BlindReviewPanel {...props} experimentId="next" service={runtime} />)
    await act(async () => release(snapshot))
    expect(screen.queryByText("Left output")).not.toBeInTheDocument()
    const next = service()
    const scoped = { ...next, scopeId: "scope-2" }
    next.load.mockResolvedValue(snapshot)
    rerender(<BlindReviewPanel {...props} service={scoped} />)
    await screen.findByText("Left output")
    rerender(<BlindReviewPanel {...props} service={null} />)
    expect(screen.queryByText("Left output")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("lab.review.blind.password")).not.toBeInTheDocument()
  })

  it("ignores the abandoned StrictMode load, including its busy cleanup", async () => {
    const runtime = service()
    let first!: (value: EvalReviewSnapshot | null) => void
    let second!: (value: EvalReviewSnapshot | null) => void
    runtime.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve
        })
    )
    runtime.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          second = resolve
        })
    )
    render(
      <StrictMode>
        <BlindReviewPanel {...props} service={runtime} />
      </StrictMode>
    )
    await waitFor(() => expect(runtime.load).toHaveBeenCalledTimes(2))
    await act(async () => first(snapshot))
    expect(screen.queryByText("Left output")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "lab.review.blind.create" })).toBeDisabled()
    await act(async () => second(null))
    expect(screen.getByRole("button", { name: "lab.review.blind.create" })).toBeEnabled()
  })

  it("shows load and create failures", async () => {
    const runtime = service()
    runtime.load.mockRejectedValueOnce(new Error("load failed"))
    runtime.open.mockRejectedValueOnce(new Error("create failed"))
    render(<BlindReviewPanel {...props} service={runtime} />)
    await screen.findByText("load failed")
    fireEvent.click(screen.getByRole("button", { name: "lab.review.blind.create" }))
    await screen.findByText("create failed")
  })
})

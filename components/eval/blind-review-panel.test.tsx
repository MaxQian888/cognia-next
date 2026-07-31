/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { EvalReportCaseEvidence } from "@/lib/ai/eval/report-view"

const createBatch = jest.fn(async (..._args: unknown[]) => ({ id: "batch-1" }))
const openBatch = jest.fn(async (..._args: unknown[]) => ({
  assignments: [
    {
      assignmentId: "assignment-1",
      pairId: "case-1:1:a:b",
      left: { sampleId: "sample-a", output: "Left output" },
      right: { sampleId: "sample-b", output: "Right output" },
    },
  ],
  privateMapping: {},
}))
const mergeVotes = jest.fn(async (..._args: unknown[]) => 1)
const mockCreateBundle = jest.fn(async (..._args: unknown[]) => ({
  schema: "cognia-eval-review/v1",
}))
const mockImportBundle = jest.fn(async (..._args: unknown[]) => 1)
const mockAdjudicate = jest.fn(async (..._args: unknown[]) => ({ id: "adjudication" }))
const mockRefreshRecommendation = jest.fn(async (..._args: unknown[]) => undefined)

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/ai/eval/review-service", () => ({
  createBlindReviewBatch: (...args: unknown[]) => createBatch(...args),
  openBlindReviewBatch: (...args: unknown[]) => openBatch(...args),
  createEvalReviewBundle: (...args: unknown[]) => mockCreateBundle(...args),
  importEvalReviewBundle: (...args: unknown[]) => mockImportBundle(...args),
  adjudicateEvalReview: (...args: unknown[]) => mockAdjudicate(...args),
  reviewAgreement: () => ({ eligiblePairs: 1, agreedPairs: 1, agreementRate: 1 }),
}))
jest.mock("@/lib/db/eval-lab", () => ({
  mergeEvalReviewVotes: (...args: unknown[]) => mergeVotes(...args),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    evalReviewVotes: {
      where: () => ({ equals: () => ({ toArray: async () => [] }) }),
    },
  }),
}))
jest.mock("@/lib/ai/eval/finalization", () => ({
  refreshEvalRecommendationAfterReview: (...args: unknown[]) => mockRefreshRecommendation(...args),
}))

import { BlindReviewPanel, buildBlindReviewPairs } from "./blind-review-panel"

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

describe("BlindReviewPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    createBatch.mockResolvedValue({ id: "batch-1" })
  })

  it("builds every pairwise blinded comparison for a case/repetition group", () => {
    const pairs = buildBlindReviewPairs([
      evidence("a", "sample-a", "A"),
      evidence("b", "sample-b", "B"),
      evidence("c", "sample-c", "C"),
    ])

    expect(pairs).toHaveLength(3)
    expect(pairs.map((pair) => pair.pairId)).toEqual([
      "case-1:1:a:b",
      "case-1:1:a:c",
      "case-1:1:b:c",
    ])
  })

  it("creates a blind batch and persists reviewer identity with the vote", async () => {
    const user = userEvent.setup()
    const onRecommendationChanged = jest.fn(async () => undefined)
    render(
      <BlindReviewPanel
        experimentId="experiment"
        cases={[evidence("a", "sample-a", "A"), evidence("b", "sample-b", "B")]}
        artifactKey={new Uint8Array(32)}
        seed={42}
        onRecommendationChanged={onRecommendationChanged}
      />
    )

    await user.click(screen.getByRole("button", { name: "lab.review.blind.create" }))
    expect(createBatch).toHaveBeenCalledWith(expect.objectContaining({ seed: 42 }))
    expect(screen.getByText("Left output")).toBeInTheDocument()

    await user.type(screen.getByLabelText("lab.review.blind.reviewer"), "reviewer-1")
    await user.click(screen.getByRole("button", { name: "lab.review.blind.preferLeft" }))
    expect(mergeVotes).toHaveBeenCalledWith([
      expect.objectContaining({ reviewerId: "reviewer-1", preference: "a" }),
    ])
    expect(mockRefreshRecommendation).toHaveBeenCalledWith("experiment", expect.any(Uint8Array))
    expect(onRecommendationChanged).toHaveBeenCalledTimes(1)
  })

  it("does not expose assignment controls until an artifact key and pair exist", () => {
    render(<BlindReviewPanel experimentId="experiment" cases={[]} artifactKey={null} seed={1} />)
    expect(screen.getByRole("button", { name: "lab.review.blind.create" })).toBeDisabled()
    expect(screen.getByText("lab.review.blind.noPairs")).toBeInTheDocument()
  })

  it("exports, merges, and adjudicates portable review work", async () => {
    const user = userEvent.setup()
    const onRecommendationChanged = jest.fn(async () => undefined)
    render(
      <BlindReviewPanel
        experimentId="experiment"
        cases={[evidence("a", "sample-a", "A"), evidence("b", "sample-b", "B")]}
        artifactKey={new Uint8Array(32)}
        seed={42}
        onRecommendationChanged={onRecommendationChanged}
      />
    )
    await user.click(screen.getByRole("button", { name: "lab.review.blind.create" }))
    await user.type(screen.getByLabelText("lab.review.blind.password"), "password")
    await user.click(screen.getByRole("button", { name: "lab.review.blind.export" }))
    const bundle = screen.getByLabelText("lab.review.blind.bundle")
    expect((bundle as HTMLTextAreaElement).value).toContain("cognia-eval-review/v1")
    await user.click(screen.getByRole("button", { name: "lab.review.blind.import" }))
    expect(mockImportBundle).toHaveBeenCalledWith(
      expect.objectContaining({ schema: "cognia-eval-review/v1" }),
      "password"
    )
    expect(onRecommendationChanged).toHaveBeenCalledTimes(1)

    await user.type(screen.getByLabelText("lab.review.blind.adjudicator"), "lead-reviewer")
    await user.type(screen.getByLabelText("lab.review.blind.reasoning"), "Resolved conflict")
    await user.click(screen.getByRole("button", { name: "lab.review.blind.decisions.a" }))
    expect(mockAdjudicate).toHaveBeenCalledWith(
      expect.objectContaining({
        adjudicatorId: "lead-reviewer",
        decision: "a",
        reasoning: "Resolved conflict",
      })
    )
    expect(mockRefreshRecommendation).toHaveBeenCalled()
    expect(onRecommendationChanged).toHaveBeenCalledTimes(2)
  })

  it("surfaces batch and malformed import failures in the panel", async () => {
    const user = userEvent.setup()
    createBatch.mockRejectedValueOnce(new Error("batch unavailable"))
    render(
      <BlindReviewPanel
        experimentId="experiment"
        cases={[evidence("a", "sample-a", "A"), evidence("b", "sample-b", "B")]}
        artifactKey={new Uint8Array(32)}
        seed={42}
      />
    )
    await user.click(screen.getByRole("button", { name: "lab.review.blind.create" }))
    expect(screen.getByText("batch unavailable")).toBeInTheDocument()
  })
})

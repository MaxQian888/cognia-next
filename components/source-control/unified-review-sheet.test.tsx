import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { diffReviewFileKey, useDiffReviewStore } from "@/stores/git/diff-review-store"
import type { PullRequestRef, ReviewFeedbackBundle } from "@/types/review"

const collectMock = jest.fn()
jest.mock("@/lib/review/scope", () => ({
  collectReviewScope: (...args: unknown[]) => collectMock(...args),
}))
jest.mock("./commit-box", () => ({ CommitBox: () => <div>Commit controls</div> }))

import { UnifiedReviewSheet } from "./unified-review-sheet"

const provider = {
  id: "github",
  getAuthenticationState: jest.fn(async () => "authenticated" as const),
  findForBranch: jest.fn(async () => null),
  push: jest.fn(async () => undefined),
  create: jest.fn(async () => ({
    provider: "github",
    repository: "acme/repo",
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
    headRef: "feature",
    baseRef: "main",
    title: "Add review",
    state: "open" as const,
  })),
  publishFeedback: jest.fn(
    async (_pullRequest: PullRequestRef, _bundle: ReviewFeedbackBundle) => undefined
  ),
}

const actions = { commit: jest.fn(), push: jest.fn(), sync: jest.fn(), stage: jest.fn() }

beforeEach(() => {
  collectMock.mockReset().mockResolvedValue([
    {
      repositoryRoot: "/repo",
      path: "src/a.ts",
      source: "uncommitted",
      reviewKey: "src/a.ts",
      hunks: [
        {
          index: 0,
          hunkHash: "real-content-hash",
          header: "@@ -4,1 +4,2 @@",
          side: "after",
          line: 4,
        },
      ],
    },
  ])
  provider.push.mockClear()
  provider.create.mockClear()
  provider.publishFeedback.mockClear()
  useDiffReviewStore.setState({ decisions: {}, order: [] })
})

it("loads a review scope and pushes before creating a GitHub pull request", async () => {
  render(
    <UnifiedReviewSheet
      open
      onOpenChange={jest.fn()}
      rootDir="/repo"
      repositoryRoots={["/repo", "/second"]}
      branch="feature"
      stagedCount={1}
      committing={false}
      actions={actions as never}
      provider={provider}
    />
  )
  await waitFor(() => expect(provider.getAuthenticationState).toHaveBeenCalled())
  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  expect(await screen.findByText("src/a.ts")).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText("Pull request title"), { target: { value: "Add review" } })
  fireEvent.click(screen.getByRole("button", { name: "Create pull request" }))
  await waitFor(() => expect(provider.push).toHaveBeenCalledWith("/repo", "feature"))
  expect(provider.create).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Add review", draft: true })
  )
  expect(await screen.findByText(/Pull request #7/)).toBeInTheDocument()
})

it("publishes only real content-addressed hunk comments and persists the draft", async () => {
  render(
    <UnifiedReviewSheet
      open
      onOpenChange={jest.fn()}
      rootDir="/repo"
      repositoryRoots={["/repo"]}
      branch="feature"
      stagedCount={0}
      committing={false}
      actions={actions as never}
      provider={provider}
    />
  )

  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  const comment = await screen.findByLabelText("Feedback for src/a.ts at line 4")
  fireEvent.change(comment, { target: { value: "Keep this guard." } })
  expect(useDiffReviewStore.getState().decisions[diffReviewFileKey("/repo", "src/a.ts")]).toEqual([
    expect.objectContaining({ hash: "real-content-hash", comment: "Keep this guard." }),
  ])

  fireEvent.change(screen.getByLabelText("Pull request title"), {
    target: { value: "Add review" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Create pull request" }))
  await screen.findByText(/Pull request #7/)
  fireEvent.click(screen.getByRole("button", { name: "Publish feedback review" }))

  await waitFor(() => expect(provider.publishFeedback).toHaveBeenCalledTimes(1))
  expect(provider.publishFeedback.mock.calls[0]?.[1]).toEqual(
    expect.objectContaining({
      comments: [
        expect.objectContaining({
          body: "Keep this guard.",
          anchor: expect.objectContaining({
            path: "src/a.ts",
            hunkHash: "real-content-hash",
            side: "after",
            line: 4,
          }),
        }),
      ],
    })
  )
})

it("omits stale persisted comments instead of guessing a new hunk", async () => {
  useDiffReviewStore.getState().setComment("/repo", "src/a.ts", 0, "gone-hash", "Stale")

  render(
    <UnifiedReviewSheet
      open
      onOpenChange={jest.fn()}
      rootDir="/repo"
      repositoryRoots={["/repo"]}
      branch="feature"
      stagedCount={0}
      committing={false}
      actions={actions as never}
      provider={provider}
    />
  )

  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  await screen.findByText("src/a.ts")
  expect(screen.getAllByRole("status").map((node) => node.textContent)).toContain(
    "Stale hunk comments omitted: 1."
  )
  expect(await screen.findByLabelText("Feedback for src/a.ts at line 4")).toHaveValue("")
})

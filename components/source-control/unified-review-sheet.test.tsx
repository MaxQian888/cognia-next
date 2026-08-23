import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import en from "@/i18n/messages/en/unifiedReview.json"
import zh from "@/i18n/messages/zh-CN/unifiedReview.json"
import type { ReviewDeliveryLeg } from "@/types/review"
import type { UnavailableReviewRoot } from "@/lib/review/scope"
import { diffReviewFileKey, useDiffReviewStore } from "@/stores/git/diff-review-store"
import type { PullRequestRef, ReviewFeedbackBundle } from "@/types/review"

const listMock = jest.fn()
const loadMock = jest.fn()
jest.mock("@/lib/review/scope", () => ({
  listReviewScopeFiles: (...args: unknown[]) => listMock(...args),
  loadReviewScopeFile: (...args: unknown[]) => loadMock(...args),
}))

const gitStatusMock = jest.fn()
jest.mock("@/lib/git/commands", () => ({
  gitStatus: (...args: unknown[]) => gitStatusMock(...args),
}))

jest.mock("./commit-box", () => ({ CommitBox: () => <div>Commit controls</div> }))

import { UnifiedReviewSheet } from "./unified-review-sheet"

function pr(repository: string, number: number): PullRequestRef {
  return {
    provider: "github",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    headRef: "feature",
    baseRef: "main",
    title: "Add review",
    state: "open",
  }
}

const provider = {
  id: "github",
  getAuthenticationState: jest.fn(async () => "authenticated" as const),
  findForBranch: jest.fn(async (root: string) =>
    root === "/repo" ? pr("acme/repo", 7) : pr("acme/second", 9)
  ),
  push: jest.fn(async () => undefined),
  create: jest.fn(async () => pr("acme/repo", 7)),
  publishFeedback: jest.fn(
    async (_pullRequest: PullRequestRef, _bundle: ReviewFeedbackBundle) => undefined
  ),
}

const actions = { commit: jest.fn(), push: jest.fn(), sync: jest.fn(), stage: jest.fn() }

function fileRef(repositoryRoot: string, path: string) {
  return { repositoryRoot, path, source: "uncommitted" as const, reviewKey: path }
}

function hunk(hunkHash: string) {
  return { index: 0, hunkHash, header: "@@ -4,1 +4,2 @@", side: "after" as const, line: 4 }
}

function renderSheet(repositoryRoots = ["/repo"]) {
  return render(
    <UnifiedReviewSheet
      open
      onOpenChange={jest.fn()}
      rootDir="/repo"
      repositoryRoots={repositoryRoots}
      stagedCount={0}
      committing={false}
      actions={actions as never}
      provider={provider}
    />
  )
}

/** The lookup/create buttons stay disabled until the auth probe resolves. */
async function waitForAuth() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Find pull requests" })).toBeEnabled()
  )
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue({ files: [fileRef("/repo", "src/a.ts")], unavailable: [] })
  loadMock.mockReset().mockImplementation(async (_request: unknown, ref: { path: string }) => ({
    ...ref,
    hunks: [hunk(`hash:${ref.path}`)],
  }))
  gitStatusMock.mockReset().mockResolvedValue({ branch: "feature" })
  provider.push.mockClear()
  provider.create.mockClear()
  provider.publishFeedback.mockClear().mockResolvedValue(undefined)
  provider.findForBranch.mockClear()
  useDiffReviewStore.setState({ decisions: {}, order: [] })
})

/** The list step costs one RPC per root; a file's diff is paid for on open. */
it("lists files without fetching any diff until a file is opened", async () => {
  renderSheet()
  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  expect(await screen.findByText("src/a.ts")).toBeInTheDocument()
  expect(loadMock).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }))
  expect(await screen.findByLabelText("Feedback for src/a.ts at line 4")).toBeInTheDocument()
  expect(loadMock).toHaveBeenCalledTimes(1)
})

/**
 * A stored comment reaches the bundle only through its file's hunks, so a
 * collapsed file would silently drop review that was already written.
 */
it("eagerly loads a file that already carries a stored comment", async () => {
  useDiffReviewStore.getState().setComment("/repo", "src/a.ts", 0, "hash:src/a.ts", "Earlier note")
  renderSheet()
  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1))
})

it("persists an authored comment against its content hash", async () => {
  renderSheet()
  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  fireEvent.click(await screen.findByRole("button", { name: /src\/a\.ts/ }))
  const comment = await screen.findByLabelText("Feedback for src/a.ts at line 4")
  fireEvent.change(comment, { target: { value: "Keep this guard." } })
  expect(useDiffReviewStore.getState().decisions[diffReviewFileKey("/repo", "src/a.ts")]).toEqual([
    expect.objectContaining({ hash: "hash:src/a.ts", comment: "Keep this guard." }),
  ])
})

it("reports stale persisted comments instead of guessing a new hunk", async () => {
  useDiffReviewStore.getState().setComment("/repo", "src/a.ts", 0, "gone-hash", "Stale")
  renderSheet()
  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  await screen.findByText("src/a.ts")
  await waitFor(() =>
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toContain(
      "Stale hunk comments omitted: 1."
    )
  )
})

it("resolves each repository's own branch and pull request", async () => {
  gitStatusMock.mockImplementation(async (root: string) => ({
    branch: root === "/repo" ? "feature-a" : "feature-b",
  }))
  renderSheet(["/repo", "/second"])
  await waitForAuth()
  fireEvent.click(screen.getByRole("button", { name: "Find pull requests" }))
  await waitFor(() => expect(provider.findForBranch).toHaveBeenCalledTimes(2))
  expect(provider.findForBranch).toHaveBeenCalledWith("/repo", "feature-a")
  expect(provider.findForBranch).toHaveBeenCalledWith("/second", "feature-b")
  expect(await screen.findByText(/Pull request #7/)).toBeInTheDocument()
  expect(await screen.findByText(/Pull request #9/)).toBeInTheDocument()
})

/**
 * The acceptance criterion, and the bug this replaced: a two-root review used
 * to post every comment to the FIRST root's pull request.
 */
it("publishes one review per repository, each carrying only its own comments", async () => {
  listMock.mockResolvedValue({
    files: [fileRef("/repo", "src/a.ts"), fileRef("/second", "src/b.ts")],
    unavailable: [],
  })
  renderSheet(["/repo", "/second"])

  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  fireEvent.click(await screen.findByRole("button", { name: /src\/a\.ts/ }))
  fireEvent.change(await screen.findByLabelText("Feedback for src/a.ts at line 4"), {
    target: { value: "In the first repo" },
  })
  fireEvent.click(screen.getByRole("button", { name: /src\/b\.ts/ }))
  fireEvent.change(await screen.findByLabelText("Feedback for src/b.ts at line 4"), {
    target: { value: "In the second repo" },
  })

  fireEvent.click(screen.getByRole("button", { name: "Find pull requests" }))
  await waitFor(() => expect(provider.findForBranch).toHaveBeenCalledTimes(2))

  fireEvent.click(screen.getByRole("button", { name: "Publish feedback review" }))
  await waitFor(() => expect(provider.publishFeedback).toHaveBeenCalledTimes(2))

  const byRepo = Object.fromEntries(
    provider.publishFeedback.mock.calls.map(([pullRequest, bundle]) => [
      pullRequest.repository,
      bundle,
    ])
  )
  expect(byRepo["acme/repo"].repositoryRoots).toEqual(["/repo"])
  expect(byRepo["acme/repo"].comments).toHaveLength(1)
  expect(byRepo["acme/repo"].comments[0].body).toBe("In the first repo")
  expect(byRepo["acme/second"].repositoryRoots).toEqual(["/second"])
  expect(byRepo["acme/second"].comments[0].body).toBe("In the second repo")
})

/** A failure in one root leaves the other published, and retry re-sends only it. */
it("keeps a succeeded leg and retries only the failed repository", async () => {
  listMock.mockResolvedValue({
    files: [fileRef("/repo", "src/a.ts"), fileRef("/second", "src/b.ts")],
    unavailable: [],
  })
  renderSheet(["/repo", "/second"])

  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  fireEvent.click(await screen.findByRole("button", { name: /src\/a\.ts/ }))
  fireEvent.change(await screen.findByLabelText("Feedback for src/a.ts at line 4"), {
    target: { value: "A" },
  })
  fireEvent.click(screen.getByRole("button", { name: /src\/b\.ts/ }))
  fireEvent.change(await screen.findByLabelText("Feedback for src/b.ts at line 4"), {
    target: { value: "B" },
  })
  await waitForAuth()
  fireEvent.click(screen.getByRole("button", { name: "Find pull requests" }))
  await waitFor(() => expect(provider.findForBranch).toHaveBeenCalledTimes(2))

  provider.publishFeedback
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("rate limited"))
  fireEvent.click(screen.getByRole("button", { name: "Publish feedback review" }))
  await waitFor(() => expect(provider.publishFeedback).toHaveBeenCalledTimes(2))

  expect(await screen.findByText("Published")).toBeInTheDocument()
  expect(await screen.findByText("Failed")).toBeInTheDocument()

  provider.publishFeedback.mockClear().mockResolvedValue(undefined)
  // Matched loosely on purpose: jest.setup.ts's next-intl mock resolves only
  // `=N` and `other` plural branches, so a `one {…}` message renders its
  // `other` form here even though the app shows the singular.
  fireEvent.click(await screen.findByRole("button", { name: /Retry 1 repositor/ }))
  await waitFor(() => expect(provider.publishFeedback).toHaveBeenCalledTimes(1))
  expect(provider.publishFeedback.mock.calls[0][1].repositoryRoots).toEqual(["/second"])
})

it("marks a repository with no pull request as skipped rather than failing the delivery", async () => {
  listMock.mockResolvedValue({ files: [fileRef("/repo", "src/a.ts")], unavailable: [] })
  renderSheet(["/repo"])
  fireEvent.click(screen.getByRole("button", { name: "Load review" }))
  fireEvent.click(await screen.findByRole("button", { name: /src\/a\.ts/ }))
  fireEvent.change(await screen.findByLabelText("Feedback for src/a.ts at line 4"), {
    target: { value: "Note" },
  })

  fireEvent.click(screen.getByRole("button", { name: "Publish feedback review" }))
  expect(await screen.findByText("No pull request")).toBeInTheDocument()
  expect(provider.publishFeedback).not.toHaveBeenCalled()
})

/**
 * Both of these keys are interpolated (`delivery.${status}`,
 * `unavailable.${reason}`), and `lint:i18n` skips every dynamic reference — a
 * missing entry would render the raw enum to the user and no gate would notice.
 * The `never` witnesses fail the typecheck if either union grows.
 */
type Covers<Union, List extends readonly Union[]> =
  Exclude<Union, List[number]> extends never ? true : never

const LEG_STATUSES = ["pending", "succeeded", "failed", "skipped"] as const
const _legStatuses: Covers<ReviewDeliveryLeg["status"], typeof LEG_STATUSES> = true

const UNAVAILABLE_REASONS = ["missing-run", "missing-commit", "missing-refs"] as const
const _reasons: Covers<UnavailableReviewRoot["reason"], typeof UNAVAILABLE_REASONS> = true

void [_legStatuses, _reasons]

it("has a label for every delivery status and unavailable reason, in both locales", () => {
  for (const status of LEG_STATUSES) {
    expect([status, typeof en.delivery[status]]).toEqual([status, "string"])
    expect([status, typeof zh.delivery[status]]).toEqual([status, "string"])
  }
  for (const reason of UNAVAILABLE_REASONS) {
    expect([reason, typeof en.unavailable[reason]]).toEqual([reason, "string"])
    expect([reason, typeof zh.unavailable[reason]]).toEqual([reason, "string"])
  }
})

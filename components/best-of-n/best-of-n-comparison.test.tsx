import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { BestOfNComparison } from "./best-of-n-comparison"
import { useBestOfNRun } from "@/hooks/best-of-n/use-best-of-n-run"
import {
  pickBestOfNCandidate,
  publishBestOfNCandidate,
  archiveBestOfN,
} from "@/lib/best-of-n/publication"
import { getSourceControlService } from "@/lib/scm/service"
import { makeChangeset } from "@/components/source-control/agent-changes/test-fixtures"
import type { BestOfNRunSummary } from "@/types/best-of-n"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    key === "candidate" ? `Candidate ${values?.number}` : key,
}))
jest.mock("@/hooks/best-of-n/use-best-of-n-run", () => ({ useBestOfNRun: jest.fn() }))
jest.mock("@/lib/best-of-n/publication", () => ({
  pickBestOfNCandidate: jest.fn(),
  runChecksBestOfNCandidate: jest.fn(),
  publishBestOfNCandidate: jest.fn(),
  archiveBestOfN: jest.fn(),
}))
jest.mock("@/lib/best-of-n/service", () => ({ cancelBestOfN: jest.fn() }))
jest.mock("@/lib/best-of-n/projection", () => ({ listBestOfNRuns: jest.fn() }))
jest.mock("@/lib/scm/host", () => ({ createScmHost: () => ({}) }))
jest.mock("@/lib/scm/service", () => ({ getSourceControlService: jest.fn() }))
jest.mock("@/components/source-control/agent-changes/changeset-detail", () => ({
  ChangesetDetail: ({ readOnly }: { readOnly: boolean }) => (
    <div data-testid="detail" data-readonly={String(readOnly)} />
  ),
}))
jest.mock("@/components/source-control/diff-viewer", () => ({
  DiffViewer: ({
    diff,
    edit,
    readOnly,
  }: {
    diff: { path: string }
    edit?: unknown
    readOnly: boolean
  }) => (
    <div data-testid="diff" data-edit={String(Boolean(edit))} data-readonly={String(readOnly)}>
      {diff.path}
    </div>
  ),
}))
const refresh = jest.fn().mockResolvedValue(undefined)
let row: BestOfNRunSummary
beforeEach(() => {
  jest.clearAllMocks()
  const changeset = makeChangeset({
    headSha: "head1",
    requiredChecks: ["unit"],
    checks: [
      {
        headSha: "head1",
        profileId: "unit",
        outcome: "passed",
        tier: null,
        reportDigest: null,
        logTail: null,
        ranAt: 1,
      },
    ],
  })
  row = {
    id: "group",
    parentSessionId: "parent",
    updatedAt: 2,
    requiredChecks: ["unit"],
    candidateChangesets: { c1: changeset },
    group: {
      groupId: "group",
      requestId: "req",
      repositoryId: "repo",
      repoCommonDir: "/repo/.git",
      sourceRoot: "/repo",
      baseSha: "base",
      checkoutHadUncommittedChanges: true,
      targetRef: "refs/heads/result",
      targetIsNew: true,
      n: 2,
      budgetPolicy: {},
      teamRunId: "team",
      phase: "awaitingSelection",
      selectedCandidateId: null,
      selectedHeadSha: null,
      integrationId: null,
      version: 1,
      ownerId: "owner",
      ownerLeaseExpiresAt: 99,
      archiveStatus: "pending",
      archiveError: null,
      error: null,
      createdAt: 0,
      updatedAt: 2,
      candidates: [1, 2].map((index) => ({
        candidateId: `c${index}`,
        index: index - 1,
        agent: { agentId: "agent" },
        childSessionId: `s${index}`,
        workspaceBundleId: null,
        physicalRoot: null,
        changesetId: index === 1 ? changeset.changesetId : null,
        headSha: index === 1 ? "head1" : null,
        status: "succeeded",
        hasChanges: index === 1,
        costUsd: null,
        startedAt: 0,
        finishedAt: 2,
        error: null,
      })),
    },
  }
  jest
    .mocked(useBestOfNRun)
    .mockImplementation(() => ({ summary: row, refresh, canManage: true, failed: false }))
})
it("shows unknown cost and disables selection of a no-change candidate", async () => {
  render(<BestOfNComparison groupId="group" />)
  expect(
    within(screen.getByRole("article", { name: "Candidate 2" })).getByRole("button", {
      name: "pick",
    })
  ).toBeDisabled()
  expect(screen.getAllByText("unknown").length).toBeGreaterThan(0)
  fireEvent.click(
    within(screen.getByRole("article", { name: "Candidate 1" })).getByRole("button", {
      name: "pick",
    })
  )
  await waitFor(() => expect(pickBestOfNCandidate).toHaveBeenCalledWith("group", "c1"))
  expect(publishBestOfNCandidate).not.toHaveBeenCalled()
})
it("publishes only through the selected-group API after an explicit confirmation", async () => {
  row.group.phase = "publishing"
  row.group.selectedCandidateId = "c1"
  row.group.selectedHeadSha = "head1"
  render(<BestOfNComparison groupId="group" />)
  fireEvent.click(screen.getByRole("button", { name: "publish" }))
  expect(publishBestOfNCandidate).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "confirm" }))
  await waitFor(() => expect(publishBestOfNCandidate).toHaveBeenCalledWith("group"))
  expect(
    screen
      .getAllByRole("button", { name: "pick" })
      .every((button) => button.hasAttribute("disabled"))
  ).toBe(true)
})
it("refuses stale-head check evidence and keeps paired views read-only", () => {
  row.group.phase = "publishing"
  row.group.selectedCandidateId = "c1"
  row.group.selectedHeadSha = "head1"
  row.candidateChangesets!.c1.checks[0].headSha = "old"
  const view = render(<BestOfNComparison groupId="group" />)
  expect(screen.getByRole("button", { name: "publish" })).toBeDisabled()
  jest
    .mocked(useBestOfNRun)
    .mockReturnValue({ summary: row, refresh, canManage: false, failed: false })
  view.rerender(<BestOfNComparison groupId="group" />)
  expect(screen.getByRole("button", { name: "runChecks" })).toBeDisabled()
  expect(screen.getByText("pairedReadOnly")).toBeInTheDocument()
})
it("loads immutable revision diffs and never supplies an editing binding", async () => {
  const diffRevisionFile = jest.fn().mockResolvedValue({ path: "src/a.ts" })
  jest.mocked(getSourceControlService).mockReturnValue({ diffRevisionFile } as never)
  render(<BestOfNComparison groupId="group" />)
  const path = row.candidateChangesets!.c1.files[0].path
  fireEvent.click(screen.getByRole("button", { name: path }))
  await screen.findByTestId("diff")
  expect(diffRevisionFile).toHaveBeenCalledWith("/repo", "base", "head1", path)
  expect(screen.getByTestId("diff")).toHaveAttribute("data-edit", "false")
  expect(screen.getByTestId("detail")).toHaveAttribute("data-readonly", "true")
})
it("keeps successful publication visible when archive fails and supports retry", async () => {
  row.group.phase = "published"
  row.group.archiveStatus = "failed"
  row.group.archiveError = "failed"
  render(<BestOfNComparison groupId="group" />)
  expect(screen.getByText("phase.published")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "retryArchive" }))
  await waitFor(() => expect(archiveBestOfN).toHaveBeenCalledWith("group"))
})

it("shows a blocked publication outcome and archives active attempts explicitly", async () => {
  row.group.phase = "publishing"
  row.group.selectedCandidateId = "c1"
  row.group.selectedHeadSha = "head1"
  jest.mocked(publishBestOfNCandidate).mockResolvedValueOnce({
    group: row.group,
    archiveError: null,
    outcome: { kind: "blocked", reason: "checks" },
  } as never)
  const view = render(<BestOfNComparison groupId="group" />)
  fireEvent.click(screen.getByRole("button", { name: "publish" }))
  fireEvent.click(screen.getByRole("button", { name: "confirm" }))
  await screen.findByText("actionFailed")
  expect(screen.getByText(/"reason":"checks"/)).toBeInTheDocument()
  row.group.phase = "running"
  view.rerender(<BestOfNComparison groupId="group" />)
  fireEvent.click(screen.getByRole("button", { name: "archive" }))
  await waitFor(() => expect(archiveBestOfN).toHaveBeenCalledWith("group"))
})
it("offers cleanup retry after Host workspace archive succeeds but session archive fails", () => {
  row.group.phase = "published"
  row.group.archiveStatus = "archived"
  row.sessionArchiveError = "session offline"
  render(<BestOfNComparison groupId="group" />)
  expect(screen.getByRole("button", { name: "retryArchive" })).toBeEnabled()
  expect(screen.getByText("archiveFailed")).toBeInTheDocument()
})

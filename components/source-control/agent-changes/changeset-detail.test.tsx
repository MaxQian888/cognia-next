import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useTranslations } from "next-intl"
import { useAgentChangesets } from "@/hooks/scm/use-agent-changesets"
import { createScmRuntime } from "@/lib/scm/runtime"
import { ChangesetDetail } from "./changeset-detail"
import { makeChangeset, makeHost, makeReview } from "./test-fixtures"
import { REVIEW_REASON_KEYS } from "./presentation"
import type { ChangesetState } from "@/lib/scm/types"

jest.mock("@/lib/scm/runtime", () => ({ createScmRuntime: jest.fn() }))
jest.mock("next-intl", () => {
  const translate = jest.fn((key: string) => key)
  return { useTranslations: () => translate }
})

function setup(changeset = makeChangeset({ review: makeReview() }), host = makeHost([changeset])) {
  function Harness() {
    const actions = useAgentChangesets({
      rootDir: "/repo",
      projectId: null,
      appSettings: null,
      host,
    })
    return <ChangesetDetail changeset={changeset} host={host} projectId={null} actions={actions} />
  }
  const view = render(<Harness />)
  return { ...view, host }
}

it("translates all known reasons and uses a generic fallback for unknown codes", async () => {
  setup(
    makeChangeset({
      review: makeReview({
        reasons: [
          ...Object.keys(REVIEW_REASON_KEYS),
          "reviewPolicyInvalid",
          "reviewPolicyInvalid:invalidProfiles",
          "futureReason",
        ],
      }),
    })
  )
  await waitFor(() => expect(screen.getByText("gaps.missingHumanApproval")).toBeInTheDocument())
  const reasons = screen.getByTestId("review-reasons")
  for (const key of Object.values(REVIEW_REASON_KEYS))
    expect(within(reasons).getByText(key)).toBeInTheDocument()
  expect(within(reasons).getAllByText("reasons.reviewPolicyInvalid")).toHaveLength(2)
  expect(within(reasons).getByText("reasons.unknown")).toBeInTheDocument()
  expect(useTranslations("agentChanges")).toHaveBeenCalledWith("reasons.unknown", {
    code: "futureReason",
  })
})

it("shows risk reasons before approving the viewed head via the review helper", async () => {
  const { host } = setup()
  await userEvent.click(screen.getByTestId("changeset-approve"))
  const dialog = screen.getByRole("alertdialog")
  expect(within(dialog).getByText("reasons.protectedCi")).toBeInTheDocument()
  expect(host.approveChangeset).not.toHaveBeenCalled()
  await userEvent.click(within(dialog).getByTestId("changeset-confirm"))
  await waitFor(() =>
    expect(host.approveChangeset).toHaveBeenCalledWith("cs-1", "b".repeat(40), "user")
  )
  expect(host.recordChangesetReview).toHaveBeenCalledWith(
    "cs-1",
    expect.objectContaining({ verdict: "approve", reviewer: "user", reasons: ["protectedPath:ci"] })
  )
  expect(host.listChangesets).toHaveBeenCalledTimes(2)
})

it("sends a trimmed request-changes note and confirms abandon", async () => {
  const { host } = setup()
  const submit = screen.getByTestId("changeset-request-changes")
  expect(submit).toBeDisabled()
  await userEvent.type(screen.getByRole("textbox"), "  Add edge-case tests  ")
  await userEvent.click(submit)
  await waitFor(() =>
    expect(host.recordChangesetReview).toHaveBeenCalledWith(
      "cs-1",
      expect.objectContaining({
        verdict: "requestChanges",
        findings: [{ path: "", severity: "critical", note: "Add edge-case tests" }],
      })
    )
  )
  expect(screen.getByRole("textbox")).toHaveValue("")
  await userEvent.click(screen.getByTestId("changeset-abandon"))
  expect(host.abandonChangeset).not.toHaveBeenCalled()
  await userEvent.click(within(screen.getByRole("alertdialog")).getByTestId("changeset-confirm"))
  await waitFor(() => expect(host.abandonChangeset).toHaveBeenCalledWith("cs-1"))
})

it("calls the runtime review with a signal and explains missing project checks", async () => {
  const host = makeHost()
  const review = jest.fn().mockResolvedValue({ changeset: makeChangeset() })
  jest.mocked(createScmRuntime).mockReturnValue({ host, review, integrate: jest.fn() })
  setup(makeChangeset(), host)
  expect(screen.getByRole("note")).toHaveTextContent("noProject")
  await userEvent.click(screen.getByTestId("changeset-review"))
  await waitFor(() => expect(review).toHaveBeenCalledWith("cs-1", expect.any(AbortSignal)))
  expect(createScmRuntime).toHaveBeenCalledWith({ projectId: null, appSettings: null, host })
})

it("renders files, findings by severity, check logs and bound SHA values", async () => {
  const original = makeChangeset()
  const changeset = makeChangeset({
    files: [{ ...original.files[0], binary: true, excluded: true }],
    review: makeReview({
      findings: [
        { path: "src/a.ts", severity: "warning", note: "warn" },
        { path: "src/b.ts", severity: "critical", note: "critical" },
        { path: "src/c.ts", severity: "info", note: "info" },
      ],
    }),
    approval: { headSha: "b".repeat(40), approver: "user", approvedAt: 1 },
    checks: [
      {
        headSha: "b".repeat(40),
        profileId: "unit",
        outcome: "inconclusive",
        tier: "process",
        reportDigest: null,
        logTail: "test log",
        ranAt: 0,
      },
    ],
  })
  setup(changeset)
  await waitFor(() => expect(screen.getByText("gaps.missingHumanApproval")).toBeInTheDocument())
  expect(screen.getByText("detail.binary")).toBeInTheDocument()
  expect(screen.getByText("detail.withheldSensitive")).toBeInTheDocument()
  expect(screen.getByText("test log")).not.toBeVisible()
  await userEvent.click(screen.getByText("detail.logTail"))
  expect(screen.getByText("test log")).toBeVisible()
  const headings = screen
    .getAllByRole("heading", { level: 5 })
    .map((heading) => heading.textContent)
  expect(headings).toEqual(["severity.critical", "severity.warning", "severity.info"])
  expect(useTranslations("agentChanges")).toHaveBeenCalledWith("detail.reviewHead", {
    sha: "bbbbbbbb",
  })
  expect(useTranslations("agentChanges")).toHaveBeenCalledWith("detail.approvalHead", {
    sha: "bbbbbbbb",
    approver: "user",
  })
})

it.each<ChangesetState>([
  "draft",
  "queued",
  "integrating",
  "merged",
  "conflicted",
  "failed",
  "rolledBack",
  "abandoned",
])("disables prohibited review actions in %s", async (state) => {
  setup(makeChangeset({ state }))
  await waitFor(() => expect(screen.getByText("gaps.missingHumanApproval")).toBeInTheDocument())
  expect(screen.getByTestId("changeset-approve")).toBeDisabled()
  expect(screen.getByTestId("changeset-request-changes")).toBeDisabled()
  if (state !== "draft") expect(screen.getByTestId("changeset-review")).toBeDisabled()
  if (["integrating", "merged", "rolledBack", "abandoned"].includes(state))
    expect(screen.getByTestId("changeset-abandon")).toBeDisabled()
})

it("retries eligibility and keeps a failed confirmation open", async () => {
  const host = makeHost()
  host.changesetEligibility.mockRejectedValueOnce(new Error("offline"))
  host.approveChangeset.mockRejectedValueOnce({ code: "stale_head" })
  setup(makeChangeset({ review: makeReview() }), host)
  await screen.findByText("errors.eligibility")
  await userEvent.click(screen.getByRole("button", { name: "retry" }))
  await screen.findByText("gaps.missingHumanApproval")
  await userEvent.click(screen.getByTestId("changeset-approve"))
  await userEvent.click(screen.getByTestId("changeset-confirm"))
  await waitFor(() =>
    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(
      "errors.action"
    )
  )
  expect(host.listChangesets).toHaveBeenCalledTimes(2)
})

it("ignores an eligibility response after unmount", async () => {
  const host = makeHost()
  let finish!: (value: { eligible: boolean; gaps: [] }) => void
  host.changesetEligibility.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { unmount } = setup(makeChangeset(), host)
  unmount()
  await act(async () => finish({ eligible: true, gaps: [] }))
})

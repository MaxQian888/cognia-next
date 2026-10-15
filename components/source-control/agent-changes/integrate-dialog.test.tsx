import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { gitBranches } from "@/lib/git/commands"
import { createScmRuntime } from "@/lib/scm/runtime"
import type { IntegrationOutcomeKind } from "@/lib/scm/integration/orchestrator"
import { useAgentChangesets } from "@/hooks/scm/use-agent-changesets"
import { IntegrateDialog } from "./integrate-dialog"
import { makeChangeset, makeHost, makeIntegration } from "./test-fixtures"

jest.mock("@/lib/git/commands", () => ({ gitBranches: jest.fn() }))
jest.mock("@/lib/scm/runtime", () => ({ createScmRuntime: jest.fn() }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const branch = (name: string, isCurrent = false, isRemote = false) => ({
  name,
  isCurrent,
  isRemote,
  upstream: null,
  ahead: 0,
  behind: 0,
  checkedOutIn: null,
  checkoutLocked: false,
})
const changesets = [
  makeChangeset({ state: "approved", requiredChecks: ["unit"] }),
  makeChangeset({
    changesetId: "cs-2",
    title: "Add tests",
    state: "queued",
    requiredChecks: ["unit", "lint"],
  }),
]

function setup(kind: IntegrationOutcomeKind = "published", host = makeHost(changesets)) {
  const integrate = jest.fn().mockResolvedValue({
    kind,
    analysis: {
      order: ["cs-1", "cs-2"],
      predictedConflicts: [],
      overlaps: [],
      prediction: "mergeTree",
      cycles: [],
    },
    run: makeIntegration({
      resultSha: "d".repeat(40),
      items: [
        {
          changesetId: "cs-2",
          headSha: "b".repeat(40),
          outcome: "conflicted",
          conflictFiles: ["src/conflict.ts"],
          commitSha: null,
        },
      ],
    }),
    dropped: ["cs-1"],
    reason: kind === "published" ? undefined : "checks_unmet",
  })
  jest.mocked(createScmRuntime).mockReturnValue({ host, review: jest.fn(), integrate })
  const onClose = jest.fn()
  function Harness() {
    const actions = useAgentChangesets({
      rootDir: "/repo",
      projectId: "project-1",
      appSettings: null,
      host,
    })
    return (
      <IntegrateDialog
        rootDir="/repo"
        projectId="project-1"
        changesets={changesets}
        host={host}
        actions={actions}
        onClose={onClose}
      />
    )
  }
  const view = render(<Harness />)
  return { ...view, host, integrate, onClose }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest
    .mocked(gitBranches)
    .mockResolvedValue([
      branch("main", true),
      branch("release"),
      branch("origin/main", false, true),
    ])
})

it("previews conflicts and overlaps, and integrates with a local target ref and union of checks", async () => {
  const host = makeHost(changesets)
  host.analyzeIntegration.mockResolvedValue({
    order: ["cs-2", "cs-1"],
    predictedConflicts: [{ a: "cs-1", b: "target", files: ["conflict.ts"] }],
    overlaps: [{ a: "cs-1", b: "cs-2", files: ["shared.ts"] }],
    prediction: "overlapOnly",
    cycles: [],
  })
  const { integrate } = setup("published", host)
  await screen.findByTestId("integration-analysis")
  expect(screen.getByTestId("integration-target")).toHaveValue("main")
  expect(screen.queryByRole("option", { name: "origin/main" })).not.toBeInTheDocument()
  expect(screen.getByText("conflict.ts")).toBeInTheDocument()
  expect(screen.getByText("shared.ts")).toBeInTheDocument()
  expect(screen.getByRole("note")).toHaveTextContent("integrate.overlapOnly")
  expect(host.analyzeIntegration).toHaveBeenCalledWith(["cs-1", "cs-2"], "refs/heads/main")
  await userEvent.selectOptions(screen.getByTestId("integration-target"), "release")
  await waitFor(() =>
    expect(host.analyzeIntegration).toHaveBeenLastCalledWith(["cs-1", "cs-2"], "refs/heads/release")
  )
  await userEvent.selectOptions(screen.getByTestId("integration-strategy"), "rebase")
  await userEvent.selectOptions(screen.getByTestId("integration-conflict-policy"), "stop")
  await userEvent.click(screen.getByTestId("integration-submit"))
  await waitFor(() =>
    expect(integrate).toHaveBeenCalledWith({
      changesetIds: ["cs-1", "cs-2"],
      targetRef: "refs/heads/release",
      strategy: "rebase",
      onConflict: "stop",
      requiredChecks: ["unit", "lint"],
      signal: expect.any(AbortSignal),
    })
  )
  expect(host.listChangesets).toHaveBeenCalledTimes(2)
})

it.each<IntegrationOutcomeKind>(["published", "conflicted", "failed", "blocked"])(
  "renders the %s outcome, dropped culprits and conflicted files",
  async (kind) => {
    setup(kind)
    await waitFor(() => expect(screen.getByTestId("integration-submit")).toBeEnabled())
    await userEvent.click(screen.getByTestId("integration-submit"))
    const outcome = await screen.findByTestId("integration-outcome")
    expect(outcome).toHaveAttribute("data-outcome", kind)
    expect(within(outcome).getByRole("heading", { level: 3 })).toHaveTextContent(`outcomes.${kind}`)
    expect(within(outcome).getByText("src/conflict.ts")).toBeInTheDocument()
    expect(within(outcome).getByText("Add validation")).toBeInTheDocument()
    if (kind !== "published")
      expect(within(outcome).getByText("integrationReasons.checks_unmet")).toBeInTheDocument()
    expect(screen.queryByTestId("integration-submit")).not.toBeInTheDocument()
  }
)

it("blocks cycles and does not publish without analysis", async () => {
  const host = makeHost(changesets)
  host.analyzeIntegration.mockResolvedValue({
    order: [],
    overlaps: [],
    predictedConflicts: [],
    prediction: "mergeTree",
    cycles: [["cs-1", "cs-2"]],
  })
  const { integrate } = setup("blocked", host)
  await screen.findByTestId("integration-analysis")
  expect(screen.getByTestId("integration-submit")).toBeDisabled()
  expect(screen.getByRole("alert")).toHaveTextContent("integrationReasons.cycles")
  expect(integrate).not.toHaveBeenCalled()
})

it("handles branch and preview failures with retry", async () => {
  jest.mocked(gitBranches).mockRejectedValueOnce(new Error("offline"))
  const host = makeHost(changesets)
  host.analyzeIntegration.mockRejectedValueOnce(new Error("offline"))
  setup("published", host)
  await screen.findByRole("alert")
  expect(screen.getByTestId("integration-submit")).toBeDisabled()
  await userEvent.click(screen.getByRole("button", { name: "retry" }))
  await waitFor(() => expect(host.analyzeIntegration).toHaveBeenCalledTimes(1))
  await userEvent.click(screen.getByRole("button", { name: "retry" }))
  await waitFor(() => expect(screen.getByTestId("integration-submit")).toBeEnabled())
})

it("requires an explicit branch choice for detached HEAD", async () => {
  jest.mocked(gitBranches).mockResolvedValue([branch("main")])
  const { host } = setup()
  await waitFor(() => expect(screen.getByTestId("integration-target")).toBeEnabled())
  expect(screen.getByTestId("integration-target")).toHaveValue("")
  expect(host.analyzeIntegration).not.toHaveBeenCalled()
  expect(screen.getByTestId("integration-submit")).toBeDisabled()
})

it("ignores stale analysis when the branch changes", async () => {
  const host = makeHost(changesets)
  let resolveOld!: (value: Awaited<ReturnType<typeof host.analyzeIntegration>>) => void
  host.analyzeIntegration.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  setup("published", host)
  await waitFor(() => expect(host.analyzeIntegration).toHaveBeenCalledTimes(1))
  await userEvent.selectOptions(screen.getByTestId("integration-target"), "release")
  await screen.findByTestId("integration-analysis")
  await act(async () =>
    resolveOld({
      order: [],
      overlaps: [],
      predictedConflicts: [{ a: "cs-1", b: "target", files: ["stale.ts"] }],
      cycles: [],
      prediction: "mergeTree",
    })
  )
  expect(screen.queryByText("stale.ts")).not.toBeInTheDocument()
})

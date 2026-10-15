import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useAgentChangesets } from "@/hooks/scm/use-agent-changesets"
import type { IntegrationState } from "@/lib/scm/types"
import { IntegrationRunList } from "./integration-run-list"
import { makeHost, makeIntegration } from "./test-fixtures"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

function setup(state: IntegrationState) {
  const run = makeIntegration({
    state,
    resultSha: "d".repeat(40),
    opLog: [
      {
        refName: "refs/heads/main",
        oldSha: "a".repeat(40),
        newSha: "d".repeat(40),
        reason: "publish",
        at: 1,
      },
    ],
  })
  const host = makeHost(undefined, [run])
  function Harness() {
    const actions = useAgentChangesets({
      rootDir: "/repo",
      projectId: null,
      appSettings: null,
      host,
    })
    return <IntegrationRunList integrations={[run]} actions={actions} />
  }
  render(<Harness />)
  return host
}

it.each<IntegrationState>([
  "planned",
  "preparing",
  "prepared",
  "publishing",
  "published",
  "stale",
  "conflicted",
  "failed",
  "aborted",
  "interrupted",
  "rolledBack",
])("offers only valid run actions in %s", async (state) => {
  const host = setup(state)
  await waitFor(() => expect(host.listIntegrations).toHaveBeenCalled())
  expect(screen.queryByTestId("rollback-run-1") !== null).toBe(state === "published")
  expect(screen.queryByTestId("abort-run-1") !== null).toBe(
    ["prepared", "stale", "conflicted"].includes(state)
  )
  expect(screen.getByText(`runStates.${state}`)).toBeInTheDocument()
  expect(screen.getByText("itemOutcomes.merged")).toBeInTheDocument()
})

it("requires confirmation before rollback, then refreshes", async () => {
  const host = setup("published")
  await userEvent.click(screen.getByTestId("rollback-run-1"))
  expect(host.rollbackIntegration).not.toHaveBeenCalled()
  await userEvent.click(within(screen.getByRole("alertdialog")).getByTestId("rollback-confirm"))
  await waitFor(() => expect(host.rollbackIntegration).toHaveBeenCalledWith("run-1"))
  expect(host.listIntegrations).toHaveBeenCalledTimes(2)
})

it("aborts a prepared run and expands the operation log", async () => {
  const host = setup("prepared")
  expect(screen.getByText("runs.transition")).not.toBeVisible()
  await userEvent.click(screen.getByText("runs.opLog"))
  expect(screen.getByText("runs.transition")).toBeVisible()
  await userEvent.click(screen.getByTestId("abort-run-1"))
  await waitFor(() => expect(host.abortIntegration).toHaveBeenCalledWith("run-1"))
  expect(host.listIntegrations).toHaveBeenCalledTimes(2)
})

import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentChangesView } from "./agent-changes-view"
import { makeChangeset, makeHost, makeIntegration } from "./test-fixtures"
import type { ChangesetState } from "@/lib/scm/types"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

it("groups open and done changes, filters roots and integration repositories", async () => {
  const states: ChangesetState[] = [
    "draft",
    "ready",
    "approved",
    "changesRequested",
    "queued",
    "integrating",
    "conflicted",
    "failed",
    "merged",
    "rolledBack",
    "abandoned",
  ]
  const host = makeHost(
    [
      ...states.map((state) =>
        makeChangeset({ changesetId: state, title: state, sourceRoot: "/repo/./", state })
      ),
      makeChangeset({ changesetId: "foreign", sourceRoot: "/other" }),
    ],
    [makeIntegration(), makeIntegration({ integrationId: "foreign", repoCommonDir: "/other/.git" })]
  )
  render(<AgentChangesView rootDir="/repo/" projectId={null} host={host} />)
  await screen.findByTestId("changeset-draft")
  const open = screen.getByTestId("agent-changes-open")
  expect(within(open).getAllByRole("listitem")).toHaveLength(8)
  expect(screen.queryByTestId("changeset-foreign")).not.toBeInTheDocument()
  expect(screen.queryByTestId("integration-run-foreign")).not.toBeInTheDocument()
  expect(screen.getByTestId("integration-run-run-1")).toBeInTheDocument()
  expect(screen.getByTestId("agent-changes-done-toggle")).toHaveAttribute("aria-expanded", "false")
  await userEvent.click(screen.getByTestId("agent-changes-done-toggle"))
  expect(within(screen.getByTestId("agent-changes-done")).getAllByRole("listitem")).toHaveLength(3)
  for (const state of states)
    expect(
      within(screen.getByTestId(`changeset-${state}`))
        .getByRole("checkbox")
        .hasAttribute("disabled")
    ).toBe(!["approved", "queued"].includes(state))
})

it("selects only approved/queued changes and opens detail", async () => {
  const host = makeHost([makeChangeset({ state: "approved" })])
  render(<AgentChangesView rootDir="/repo" projectId={null} host={host} />)
  const row = await screen.findByTestId("changeset-cs-1")
  expect(screen.getByTestId("agent-changes-integrate")).toBeDisabled()
  await userEvent.click(within(row).getByRole("checkbox"))
  expect(screen.getByTestId("agent-changes-integrate")).toBeEnabled()
  await userEvent.click(within(row).getByRole("button"))
  await screen.findByTestId("changeset-detail")
  await waitFor(() => expect(host.changesetEligibility).toHaveBeenCalledWith("cs-1"))
  host.listChangesets.mockResolvedValue([makeChangeset({ state: "merged" })])
  await userEvent.click(screen.getByTestId("agent-changes-refresh"))
  await waitFor(() => expect(screen.getByTestId("agent-changes-integrate")).toBeDisabled())
})

it("renders load errors, retries and refreshes on focus", async () => {
  const host = makeHost([])
  host.listChangesets.mockRejectedValueOnce(new Error("offline"))
  render(<AgentChangesView rootDir="/repo" projectId={null} host={host} />)
  expect(screen.getByRole("status")).toHaveTextContent("loading")
  expect(await screen.findByRole("alert")).toHaveTextContent("errors.load")
  await userEvent.click(screen.getByRole("button", { name: "retry" }))
  await screen.findByTestId("agent-changes-empty")
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(host.listChangesets).toHaveBeenCalledTimes(3)
})

it("clears selection and details when the repository changes", async () => {
  const host = makeHost([makeChangeset({ state: "approved" })])
  const { rerender } = render(<AgentChangesView rootDir="/repo" projectId={null} host={host} />)
  const row = await screen.findByTestId("changeset-cs-1")
  await userEvent.click(within(row).getByRole("checkbox"))
  await userEvent.click(within(row).getByRole("button"))
  rerender(<AgentChangesView rootDir="/other" projectId={null} host={host} />)
  await screen.findByTestId("agent-changes-empty")
  expect(screen.getByTestId("agent-changes-integrate")).toBeDisabled()
  expect(screen.queryByTestId("changeset-detail")).not.toBeInTheDocument()
})

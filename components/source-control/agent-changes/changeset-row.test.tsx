import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ChangesetState } from "@/lib/scm/types"
import { useTranslations } from "next-intl"
import { ChangesetRow } from "./changeset-row"
import { makeChangeset, makeReview } from "./test-fixtures"

jest.mock("next-intl", () => {
  const translate = jest.fn((key: string) => key)
  return { useTranslations: () => translate }
})

it.each<ChangesetState>([
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
])("only allows eligible selection states: %s", async (state) => {
  const onSelect = jest.fn()
  const onOpen = jest.fn()
  render(
    <ChangesetRow
      changeset={makeChangeset({ state })}
      selected={false}
      onSelect={onSelect}
      onOpen={onOpen}
    />
  )
  const checkbox = screen.getByRole("checkbox")
  if (["approved", "queued"].includes(state)) {
    expect(checkbox).toBeEnabled()
    await userEvent.click(checkbox)
    expect(onSelect).toHaveBeenCalledWith(true)
  } else {
    expect(checkbox).toBeDisabled()
    await userEvent.click(checkbox)
    expect(onSelect).not.toHaveBeenCalled()
  }
  await userEvent.click(screen.getByRole("button"))
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it("renders agent, state, risk and sensitive exclusion markers", () => {
  const original = makeChangeset()
  render(
    <ChangesetRow
      changeset={{
        ...original,
        review: makeReview(),
        files: [
          ...original.files,
          { ...original.files[0], path: ".env", sensitive: true, excluded: true },
        ],
      }}
      selected={false}
      onSelect={jest.fn()}
      onOpen={jest.fn()}
    />
  )
  expect(screen.getByText("agent-1")).toBeInTheDocument()
  for (const key of ["states.ready", "risk.high", "fileCount", "lineTotals", "excluded"])
    expect(screen.getByText(key)).toBeInTheDocument()
  expect(useTranslations("agentChanges")).toHaveBeenCalledWith("fileCount", { count: 2 })
  expect(useTranslations("agentChanges")).toHaveBeenCalledWith("lineTotals", {
    insertions: 4,
    deletions: 2,
  })
})

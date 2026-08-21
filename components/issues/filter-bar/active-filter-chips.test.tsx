/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { EMPTY_ISSUE_FILTER } from "@/lib/issues/board-model"
import { collectActiveFilterChips } from "@/lib/issues/filter-chips"
import type { LabelRow } from "@/types/labels"
import { ActiveFilterChips } from "./active-filter-chips"

const label: LabelRow = {
  id: "l1",
  scope: "issue",
  name: "bug",
  color: "#ff0000",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
}

function renderChips(
  filter: Parameters<typeof collectActiveFilterChips>[0],
  over: Partial<React.ComponentProps<typeof ActiveFilterChips>> = {}
) {
  const props: React.ComponentProps<typeof ActiveFilterChips> = {
    chips: collectActiveFilterChips(filter),
    labelsById: new Map([["l1", label]]),
    projectNamesById: new Map([["p1", "Mercury"]]),
    assigneeLabels: new Map([["agent:a1", "Scout"]]),
    onRemove: jest.fn(),
    onClearAll: jest.fn(),
    ...over,
  }
  return { props, ...render(<ActiveFilterChips {...props} />) }
}

describe("ActiveFilterChips", () => {
  it("renders nothing when no filter is engaged", () => {
    renderChips(EMPTY_ISSUE_FILTER)
    expect(screen.queryByTestId("issue-filter-chips")).not.toBeInTheDocument()
  })

  it("shows the query text itself", () => {
    renderChips({ ...EMPTY_ISSUE_FILTER, query: "auth" })
    expect(screen.getByTestId("issue-filter-chip-query:auth")).toHaveTextContent("auth")
  })

  it("resolves a label id to its name — the raw id must never reach the user", () => {
    renderChips({ ...EMPTY_ISSUE_FILTER, labelIds: ["l1"] })
    const chip = screen.getByTestId("issue-filter-chip-labelIds:l1")
    expect(chip).toHaveTextContent("bug")
    expect(chip).not.toHaveTextContent("l1")
  })

  it("resolves a project id to its name", () => {
    renderChips({ ...EMPTY_ISSUE_FILTER, issueProjectIds: ["p1"] })
    expect(screen.getByTestId("issue-filter-chip-issueProjectIds:p1")).toHaveTextContent("Mercury")
  })

  it("resolves an actor key to its cached display name", () => {
    renderChips({ ...EMPTY_ISSUE_FILTER, assignees: ["agent:a1"] })
    expect(screen.getByTestId("issue-filter-chip-assignees:agent:a1")).toHaveTextContent("Scout")
  })

  it("falls back to the raw value when nothing resolves it", () => {
    renderChips({ ...EMPTY_ISSUE_FILTER, labelIds: ["ghost"] })
    expect(screen.getByTestId("issue-filter-chip-labelIds:ghost")).toHaveTextContent("ghost")
  })

  it("localizes the enumerable facets", () => {
    renderChips({ ...EMPTY_ISSUE_FILTER, priorities: ["urgent"], sources: ["github"] })
    expect(screen.getByTestId("issue-filter-chip-priorities:urgent")).toHaveTextContent(
      "priority.urgent"
    )
    expect(screen.getByTestId("issue-filter-chip-sources:github")).toHaveTextContent(
      "source.github"
    )
  })

  it("names the facet as well as the value, so two chips are never ambiguous", () => {
    renderChips({ ...EMPTY_ISSUE_FILTER, labelIds: ["l1"] })
    expect(screen.getByTestId("issue-filter-chip-labelIds:l1")).toHaveTextContent("facet.labels")
  })

  it("removes one chip without touching the rest", () => {
    const onRemove = jest.fn()
    renderChips({ ...EMPTY_ISSUE_FILTER, labelIds: ["l1"], priorities: ["low"] }, { onRemove })
    fireEvent.click(screen.getByTestId("issue-filter-chip-remove-labelIds:l1"))
    expect(onRemove).toHaveBeenCalledWith(
      expect.objectContaining({ facet: "labelIds", value: "l1" })
    )
  })

  it("offers clear-all only once there is more than one chip to clear", () => {
    renderChips({ ...EMPTY_ISSUE_FILTER, labelIds: ["l1"] })
    expect(screen.queryByTestId("issue-filter-clear-all")).not.toBeInTheDocument()
  })

  it("clears everything at once", () => {
    const onClearAll = jest.fn()
    renderChips({ ...EMPTY_ISSUE_FILTER, labelIds: ["l1"], priorities: ["low"] }, { onClearAll })
    fireEvent.click(screen.getByTestId("issue-filter-clear-all"))
    expect(onClearAll).toHaveBeenCalled()
  })
})

/**
 * @jest-environment jsdom
 */

/**
 * The reorder half of `WorkbenchCustomizer`, in its own file because it needs
 * `CustomizerLists` stubbed.
 *
 * That component owns a dnd-kit drag, and jsdom has no layout for dnd-kit to
 * measure — a keyboard drag there resolves to a no-op, so `onReorderPinned`
 * never fires and the splice it performs goes unexercised. Standing in for the
 * list is the only way to reach it; doing so in the main suite would take the
 * real drag plumbing away from every other test.
 */

import { render, screen, fireEvent } from "@testing-library/react"

import { useSettingsStore } from "@/stores/settings/settings-store"
import type { WorkbenchRailLayout } from "@/types/shell/workbench-rail"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let lastReorderProp: ((ids: string[]) => void) | null = null
jest.mock("./customizer-list", () => ({
  CustomizerLists: ({ onReorderPinned }: { onReorderPinned: (ids: string[]) => void }) => {
    lastReorderProp = onReorderPinned
    return (
      <button
        type="button"
        data-testid="stub-reorder"
        onClick={() => onReorderPinned(["workspace", "comments"])}
      />
    )
  },
}))

import { WorkbenchCustomizer } from "./workbench-customizer"

const saveMock = jest.fn(async (_patch?: { workbenchRail?: WorkbenchRailLayout }) => {})

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.workbenchRail as WorkbenchRailLayout

beforeEach(() => {
  saveMock.mockClear()
  lastReorderProp = null
})

function renderWith(layout: WorkbenchRailLayout) {
  useSettingsStore.setState({
    settings: { workbenchRail: layout } as never,
    save: saveMock as never,
  })
  return render(<WorkbenchCustomizer />)
}

describe("WorkbenchCustomizer reorder", () => {
  it("hands the list a reorder callback", () => {
    renderWith({ order: ["review", "workspace", "comments"], hidden: [] })
    expect(lastReorderProp).toBeInstanceOf(Function)
  })

  it("splices the reordered visible ids back over the hidden ones", () => {
    // `review` is hidden, so the customizer never showed it and it cannot be in
    // the incoming id list — it has to keep its slot rather than be dropped.
    //
    // The written order also gains the activities the stored one never
    // mentioned: resolution appends them in catalog order, and what is written
    // back is the resolved order, not the sparse stored one. That normalisation
    // is the point — it is what stops a partial layout from pinning the rail to
    // whatever the catalog looked like when it was saved.
    renderWith({ order: ["review", "workspace", "comments"], hidden: ["review"] })
    fireEvent.click(screen.getByTestId("stub-reorder"))
    expect(lastSaved().order).toEqual([
      "review",
      "workspace",
      "comments",
      "preview-run",
      "ai",
      "inspect",
      "templates",
    ])
    expect(lastSaved().hidden).toEqual(["review"])
  })

  it("applies a real reordering of the visible ids", () => {
    renderWith({ order: ["comments", "workspace"], hidden: [] })
    fireEvent.click(screen.getByTestId("stub-reorder"))
    // The two named ids swap into the first two slots; the rest keep theirs.
    expect(lastSaved().order.slice(0, 2)).toEqual(["workspace", "comments"])
    expect(lastSaved().order).toHaveLength(7)
  })
})

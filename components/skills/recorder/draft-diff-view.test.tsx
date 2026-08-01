/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DraftDiffView } from "./draft-diff-view"

const CURRENT = `## When to use
Use this for the monthly export.

## Steps
1. Open billing
2. Click Export

## Verify
The file downloads.`

const CANDIDATE = `## When to use
Use this for the monthly export.

## Steps
1. Open the billing portal
2. Choose Export

## Notes
Generated afresh.`

/** The accept-all / accept-selected / keep-mine row, scoped away from the rows. */
function header() {
  return within(document.querySelector("header") as HTMLElement)
}

function renderDiff(current = CURRENT, candidate = CANDIDATE) {
  const onAccept = jest.fn()
  const onDiscard = jest.fn()
  render(
    <DraftDiffView
      current={current}
      candidate={candidate}
      onAccept={onAccept}
      onDiscard={onDiscard}
    />
  )
  return { onAccept, onDiscard }
}

describe("DraftDiffView", () => {
  it("lists only the sections that differ", () => {
    renderDiff()
    const items = screen.getAllByRole("listitem")
    expect(items).toHaveLength(3)
    const labels = items.map((i) => i.textContent ?? "")
    expect(labels.some((l) => l.includes("Steps"))).toBe(true)
    expect(labels.some((l) => l.includes("Verify"))).toBe(true)
    expect(labels.some((l) => l.includes("Notes"))).toBe(true)
    // Identical prose is not a decision the user has to make.
    expect(screen.queryByText(/When to use/)).not.toBeInTheDocument()
  })

  it("labels a section the candidate added or dropped", () => {
    renderDiff()
    expect(screen.getByText("sectionAdded")).toBeInTheDocument()
    expect(screen.getByText("sectionRemoved")).toBeInTheDocument()
  })

  it("shows both sides of a changed section", () => {
    renderDiff()
    expect(screen.getByText(/1\. Open billing/)).toBeInTheDocument()
    expect(screen.getByText(/1\. Open the billing portal/)).toBeInTheDocument()
  })

  it("takes the candidate wholesale on accept-all", async () => {
    const { onAccept } = renderDiff()
    await userEvent.click(header().getByRole("button", { name: "acceptAll" }))
    expect(onAccept).toHaveBeenCalledWith(expect.stringContaining("Open the billing portal"))
    expect(onAccept.mock.calls[0][0]).not.toContain("## Verify")
  })

  it("merges only the sections the user picked", async () => {
    // Nothing is overwritten by default — silently replacing hand-written prose
    // is the fastest way to make someone stop trusting the feature.
    const { onAccept } = renderDiff()
    expect(header().getByRole("button", { name: "acceptBlock" })).toBeDisabled()

    const stepsRow = screen
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("Open the billing portal"))!
    await userEvent.click(within(stepsRow).getByRole("button", { name: "keepMine" }))
    await userEvent.click(header().getByRole("button", { name: "acceptBlock" }))

    const merged = onAccept.mock.calls[0][0] as string
    expect(merged).toContain("Open the billing portal")
    // The candidate omitted `## Verify`; silence is not a delete.
    expect(merged).toContain("## Verify")
    expect(merged).not.toContain("## Notes")
  })

  it("marks a picked section as pressed, and lets it be unpicked", async () => {
    renderDiff()
    const stepsRow = screen.getAllByRole("listitem")[0]
    const toggle = within(stepsRow).getByRole("button", { name: "keepMine" })

    await userEvent.click(toggle)
    expect(within(stepsRow).getByRole("button", { name: "acceptBlock" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )

    await userEvent.click(within(stepsRow).getByRole("button", { name: "acceptBlock" }))
    expect(within(stepsRow).getByRole("button", { name: "keepMine" })).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  it("discards the candidate outright", async () => {
    const { onDiscard, onAccept } = renderDiff()
    await userEvent.click(header().getByRole("button", { name: "keepMine" }))
    expect(onDiscard).toHaveBeenCalled()
    expect(onAccept).not.toHaveBeenCalled()
  })

  it("says so when a regeneration changed nothing", async () => {
    const { onDiscard } = renderDiff(CURRENT, CURRENT)
    expect(screen.getByText("noChanges")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "acceptAll" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "discard" }))
    expect(onDiscard).toHaveBeenCalled()
  })

  it("names a change before the first heading rather than showing a blank label", () => {
    renderDiff("intro one\n\n## Steps\n1. Go", "intro two\n\n## Steps\n1. Go")
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("title")
  })
})

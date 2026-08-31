/**
 * @jest-environment jsdom
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { render, screen } from "@testing-library/react"

jest.mock("@/components/ui/tooltip")

import { InboxChip } from "./inbox-chip"

it("renders a bare badge when there is nothing to explain", () => {
  render(<InboxChip data-testid="c">idle</InboxChip>)
  const chip = screen.getByTestId("c")
  expect(chip).toHaveTextContent("idle")
  expect(chip.className).toContain("items-center")
})

it("carries the aria label, role and data attributes each chip contracts on", () => {
  render(
    <InboxChip
      data-testid="c"
      role="status"
      aria-label="two pending"
      dataAttributes={{ "data-count": 2, "data-active": false }}
    >
      2
    </InboxChip>
  )
  const chip = screen.getByTestId("c")
  expect(chip).toHaveAttribute("role", "status")
  expect(chip).toHaveAttribute("aria-label", "two pending")
  expect(chip).toHaveAttribute("data-count", "2")
  expect(chip).toHaveAttribute("data-active", "false")
})

it("wraps in a tooltip only when one is supplied", () => {
  const { rerender } = render(<InboxChip data-testid="c">x</InboxChip>)
  expect(screen.queryByText("why")).not.toBeInTheDocument()
  rerender(
    <InboxChip data-testid="c" tooltip="why">
      x
    </InboxChip>
  )
  expect(screen.getByText("why")).toBeInTheDocument()
})

// The bug this primitive exists to stop coming back: four chips kept
// `hidden md:inline-flex` after moving from the width-constrained header strip
// into the overflow popover, so on a phone they rendered nowhere at all.
it("adds no responsive-visibility class of its own", () => {
  render(<InboxChip data-testid="c">x</InboxChip>)
  // Split on whitespace: the Badge base carries `overflow-hidden`, which is a
  // clipping rule, not a visibility one.
  const classes = screen.getByTestId("c").className.split(/\s+/)
  expect(classes).not.toContain("hidden")
  expect(classes.filter((c) => c.startsWith("md:") || c.startsWith("sm:"))).toEqual([])
})

it("still takes a caller className, for the chips with their own colours", () => {
  render(
    <InboxChip data-testid="c" className="border-amber-500/40">
      x
    </InboxChip>
  )
  expect(screen.getByTestId("c").className).toContain("border-amber-500/40")
})

// ---------------------------------------------------------------------------
// The regression this primitive was extracted to end
// ---------------------------------------------------------------------------

/**
 * `at-strategy-chip`, `quiet-hours-chip`, `sla-badge` and `topic-runtime-chip`
 * all kept `hidden md:inline-flex` after moving out of the width-constrained
 * header strip and into the overflow popover. On a phone that meant the
 * @-strategy, quiet hours, the SLA deadline and the topic runtime rendered
 * nowhere at all, and nothing caught it because every test renders at desktop
 * width where the class is a no-op.
 *
 * A unit test cannot see that: jsdom applies no Tailwind, so a hidden element
 * is present and queryable. This reads the source instead, which is the only
 * level the mistake is visible at.
 */
describe("no inbox chip hides itself below md", () => {
  const DIR = join(__dirname)
  // Chips, badges and pills only. `inbox-shell.tsx` hides a whole PANE below
  // md, which is the single-pane mobile layout working as designed, and
  // `conversation-row.tsx` reveals its actions on hover. Neither is a read-out
  // removing itself from a popover that has room for it.
  const files = readdirSync(DIR).filter(
    (f) => /-(chip|badge|pill)\.tsx$/.test(f) && !f.includes(".test.") && !f.includes(".stories.")
  )

  it("scans a directory that actually has chips in it", () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files)("%s does not hide itself on narrow screens", (file) => {
    const source = readFileSync(join(DIR, file), "utf8")
    const offending = source
      .split("\n")
      .filter((line) => /\bhidden\s+(sm|md|lg):/.test(line) && !line.trimStart().startsWith("*"))
    expect(offending).toEqual([])
  })
})

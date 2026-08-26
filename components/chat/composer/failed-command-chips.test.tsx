/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { parseSegments } from "@/lib/slash-commands/parse-segments"
import { FailedCommandChips } from "./failed-command-chips"

const KNOWN = new Set(["help", "model", "clear", "compact", "review"])
const parse = (input: string) => parseSegments(input, (n) => KNOWN.has(n))

describe("FailedCommandChips", () => {
  it("renders nothing for plain prose", () => {
    const { container } = render(
      <FailedCommandChips segments={parse("just talking")} onRemove={jest.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  // Staged commands need no chip of their own — each one is already a pill on
  // its own token in the text. Only a FAILURE has nowhere else to appear.
  it("stays quiet for a batch that has not failed", () => {
    const { container } = render(
      <FailedCommandChips segments={parse("/compact /clear")} onRemove={jest.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("chips the command that failed, and only that one", () => {
    render(
      <FailedCommandChips
        segments={parse("/compact /clear")}
        errors={[{ name: "clear", message: "boom" }]}
        onRemove={jest.fn()}
      />
    )
    expect(screen.queryByTestId("failed-command-pill-compact")).toBeNull()
    expect(screen.getByTestId("failed-command-pill-clear")).toHaveAttribute("data-failed", "true")
  })

  it("keeps the command's position in the batch", () => {
    // "the second one failed" is the difference between re-running everything
    // and re-running one thing.
    render(
      <FailedCommandChips
        segments={parse("/compact /clear")}
        errors={[{ name: "clear", message: "boom" }]}
        onRemove={jest.fn()}
      />
    )
    expect(screen.getByTestId("failed-command-pill-clear")).toHaveTextContent("2")
  })

  // A name is not an identity. Marking every `/compact` in the line because one
  // of them failed both over-reports and puts the wrong number on a chip.
  it("chips only the occurrence that failed when a command repeats", () => {
    render(
      <FailedCommandChips
        segments={parse("/compact /clear /compact")}
        errors={[{ name: "compact", occurrence: 2, message: "boom" }]}
        onRemove={jest.fn()}
      />
    )
    const pills = screen.getAllByTestId("failed-command-pill-compact")
    expect(pills).toHaveLength(1)
    expect(pills[0]).toHaveTextContent("3")
  })

  // An error with no occurrence (an older payload, or a batch parsed from a
  // slice of the text) still surfaces — once — against a same-named command.
  it("falls back to one same-named command when the occurrence is unknown", () => {
    render(
      <FailedCommandChips
        segments={parse("/compact /clear /compact")}
        errors={[{ name: "compact", message: "boom" }]}
        onRemove={jest.fn()}
      />
    )
    expect(screen.getAllByTestId("failed-command-pill-compact")).toHaveLength(1)
  })

  it("shows the failed command's arguments", () => {
    render(
      <FailedCommandChips
        segments={parse("/model opus\n/review auth")}
        errors={[{ name: "review", message: "boom" }]}
        onRemove={jest.fn()}
      />
    )
    expect(screen.getByTestId("failed-command-pill-review")).toHaveTextContent("auth")
  })

  it("reports the exact segment range when a pill is removed", async () => {
    const onRemove = jest.fn()
    const user = userEvent.setup()
    render(
      <FailedCommandChips
        segments={parse("/compact /clear")}
        errors={[{ name: "clear", message: "boom" }]}
        onRemove={onRemove}
      />
    )
    await user.click(screen.getByRole("button", { name: /removeAria.*clear/ }))
    // `/clear` occupies [9, 15) in "/compact /clear".
    expect(onRemove).toHaveBeenCalledWith(9, 15)
  })
})

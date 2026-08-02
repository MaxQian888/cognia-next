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
import { CommandQueueBar } from "./command-queue-bar"

const KNOWN = new Set(["help", "model", "clear", "compact", "review"])
const parse = (input: string) => parseSegments(input, (n) => KNOWN.has(n))

describe("CommandQueueBar", () => {
  it("renders nothing for plain prose", () => {
    const { container } = render(
      <CommandQueueBar segments={parse("just talking")} onRemove={jest.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing for a single command (the chip overlay already shows it)", () => {
    const { container } = render(
      <CommandQueueBar segments={parse("/clear")} onRemove={jest.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders one numbered pill per command in a same-line chain", () => {
    render(<CommandQueueBar segments={parse("/compact /clear")} onRemove={jest.fn()} />)
    expect(screen.getByTestId("command-queue-pill-compact")).toBeInTheDocument()
    expect(screen.getByTestId("command-queue-pill-clear")).toBeInTheDocument()
  })

  it("renders pills for a multi-line batch and shows args", () => {
    render(<CommandQueueBar segments={parse("/model opus\n/review auth")} onRemove={jest.fn()} />)
    expect(screen.getByTestId("command-queue-pill-model")).toHaveTextContent("opus")
    expect(screen.getByTestId("command-queue-pill-review")).toHaveTextContent("auth")
  })

  it("keeps execution order", () => {
    render(<CommandQueueBar segments={parse("/compact /clear /help")} onRemove={jest.fn()} />)
    const pills = screen.getAllByTestId(/^command-queue-pill-/)
    expect(pills.map((p) => p.dataset.testid)).toEqual([
      "command-queue-pill-compact",
      "command-queue-pill-clear",
      "command-queue-pill-help",
    ])
  })

  it("reports the exact segment range when a pill is removed", async () => {
    const onRemove = jest.fn()
    const user = userEvent.setup()
    render(<CommandQueueBar segments={parse("/compact /clear")} onRemove={onRemove} />)
    await user.click(screen.getByRole("button", { name: /removeAria.*clear/ }))
    // `/clear` occupies [9, 15) in "/compact /clear".
    expect(onRemove).toHaveBeenCalledWith(9, 15)
  })

  it("marks a failed command and shows the bar even for a single command", () => {
    render(
      <CommandQueueBar
        segments={parse("/clear")}
        errors={[{ name: "clear", message: "boom" }]}
        onRemove={jest.fn()}
      />
    )
    expect(screen.getByTestId("command-queue-pill-clear")).toHaveAttribute("data-failed", "true")
  })

  it("marks only the commands that actually failed", () => {
    render(
      <CommandQueueBar
        segments={parse("/compact /clear")}
        errors={[{ name: "clear", message: "boom" }]}
        onRemove={jest.fn()}
      />
    )
    expect(screen.getByTestId("command-queue-pill-compact")).not.toHaveAttribute("data-failed")
    expect(screen.getByTestId("command-queue-pill-clear")).toHaveAttribute("data-failed", "true")
  })
})

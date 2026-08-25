import { fireEvent, render, screen } from "@testing-library/react"
import { TemplateLaunchDiffBar } from "./template-launch-diff-bar"
import type { LaunchSpecDifference } from "@/lib/chat/template/launch-spec"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const differences: LaunchSpecDifference[] = [
  { field: "characterId", wanted: "c_reviewer" },
  { field: "model", wanted: "opus", current: "sonnet" },
]

function setup(overrides: Partial<Parameters<typeof TemplateLaunchDiffBar>[0]> = {}) {
  const onStartNewSession = jest.fn()
  const onDismiss = jest.fn()
  render(
    <TemplateLaunchDiffBar
      differences={differences}
      templateName="Review a PR"
      onStartNewSession={onStartNewSession}
      onDismiss={onDismiss}
      {...overrides}
    />
  )
  return { onStartNewSession, onDismiss }
}

describe("TemplateLaunchDiffBar", () => {
  it("renders nothing when nothing would change", () => {
    // A bar that warns about non-changes is one people learn to dismiss unread.
    setup({ differences: [] })

    expect(screen.queryByTestId("template-launch-diff-bar")).not.toBeInTheDocument()
  })

  it("names each field that differs", () => {
    setup()

    const bar = screen.getByTestId("template-launch-diff-bar")
    expect(bar.querySelectorAll("[data-launch-diff-field]")).toHaveLength(2)
    expect(bar.querySelector('[data-launch-diff-field="model"]')).toHaveTextContent("opus")
  })

  it("offers a new conversation rather than changing this one", () => {
    const { onStartNewSession } = setup()

    fireEvent.click(screen.getByRole("button", { name: "startNew" }))

    expect(onStartNewSession).toHaveBeenCalled()
  })

  it("can be dismissed", () => {
    const { onDismiss } = setup()

    fireEvent.click(screen.getByRole("button", { name: "dismiss" }))

    expect(onDismiss).toHaveBeenCalled()
  })

  it("uses the caller's labels for opaque ids", () => {
    setup({ labelFor: (d) => (d.field === "characterId" ? "Agent" : d.wanted) })

    expect(screen.getByTestId("template-launch-diff-bar")).toHaveTextContent("Agent")
  })
})

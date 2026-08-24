/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { fireEvent, render, screen } from "@testing-library/react"

import type { PanelRootTarget } from "@/lib/workspace/panel-follow"

import { PanelRootChip } from "./panel-root-chip"

const target = (over: Partial<PanelRootTarget> = {}): PanelRootTarget => ({
  root: "/repos/app",
  source: "execution",
  managed: false,
  ...over,
})

function renderChip(props: Parameters<typeof PanelRootChip>[0]) {
  return render(<PanelRootChip {...props} />)
}

it("names the folder the panel is operating on", () => {
  renderChip({ panel: "terminal", target: target() })
  expect(screen.getByTestId("panel-root-name")).toHaveTextContent("app")
})

it("says the panel is following the conversation", () => {
  renderChip({ panel: "terminal", target: target() })
  expect(screen.getByTestId("panel-root-chip")).toHaveTextContent("following")
})

it("marks a managed worktree as one rather than as an ordinary checkout", () => {
  // Editing a worktree copy of a file for ten minutes before noticing is the
  // failure this exists to prevent.
  renderChip({
    panel: "editor",
    target: target({ root: "/repos/app/.cognia/wt/1", managed: true }),
  })
  const chip = screen.getByTestId("panel-root-chip")
  expect(chip).toHaveAttribute("data-managed", "true")
  expect(chip).toHaveTextContent("worktree")
})

it("says which state a pinned panel is in", () => {
  renderChip({
    panel: "sourceControl",
    target: target({ source: "pinned" }),
    onTogglePin: () => {},
  })
  expect(screen.getByTestId("panel-root-chip")).toHaveTextContent("pinned")
})

it("offers a pin control to a comparison panel", () => {
  const onTogglePin = jest.fn()
  renderChip({ panel: "sourceControl", target: target(), onTogglePin })
  fireEvent.click(screen.getByTestId("panel-root-pin"))
  expect(onTogglePin).toHaveBeenCalledTimes(1)
})

it("offers no pin control to an execution panel, even when one is passed", () => {
  // The resolver ignores such a pin, so rendering the control would lie.
  renderChip({ panel: "terminal", target: target(), onTogglePin: () => {} })
  expect(screen.queryByTestId("panel-root-pin")).toBeNull()
})

it("offers no pin control when the panel does not supply a handler", () => {
  renderChip({ panel: "editor", target: target() })
  expect(screen.queryByTestId("panel-root-pin")).toBeNull()
})

it("says so when nothing resolves rather than rendering a blank chip", () => {
  renderChip({ panel: "editor", target: target({ root: null, source: "none" }) })
  expect(screen.getByTestId("panel-root-chip-empty")).toHaveTextContent("none")
})

it("labels the pin control by what pressing it will do", () => {
  const { rerender } = renderChip({
    panel: "editor",
    target: target(),
    onTogglePin: () => {},
  })
  expect(screen.getByTestId("panel-root-pin")).toHaveAttribute("aria-label", "pinLabel")

  rerender(
    <PanelRootChip panel="editor" target={target({ source: "pinned" })} onTogglePin={() => {}} />
  )
  expect(screen.getByTestId("panel-root-pin")).toHaveAttribute("aria-label", "unpinLabel")
})

it("carries the full path, since a basename cannot tell two worktrees apart", () => {
  renderChip({ panel: "editor", target: target({ root: "/repos/app/.cognia/wt/1" }) })
  expect(screen.getByTitle("/repos/app/.cognia/wt/1")).toBeInTheDocument()
})

it("needs no tooltip provider above it", () => {
  // It is meant to drop into any panel header; requiring a provider above each
  // of them would be a coupling one path string never earns.
  expect(() => renderChip({ panel: "terminal", target: target() })).not.toThrow()
})

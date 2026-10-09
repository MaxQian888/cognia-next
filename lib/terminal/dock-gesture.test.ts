/** @jest-environment jsdom */

import { runShellViewTransition } from "@/lib/ui/shell-view-transition"
import { runTerminalDockGesture } from "./dock-gesture"

jest.mock("@/lib/ui/shell-view-transition", () => ({
  runShellViewTransition: jest.fn(({ apply }: { apply: () => void }) => {
    apply()
    return () => {}
  }),
}))

const run = jest.mocked(runShellViewTransition)

function mountShell() {
  document.body.innerHTML = `
    <div data-title-bar-outlet="center"></div>
    <div data-title-bar-outlet="end"></div>
    <div data-find-scope></div>
    <div data-testid="terminal-dock-region" data-position="bottom"></div>
    <div data-testid="terminal-dock-region" data-position="right"></div>
  `
}

afterEach(() => {
  document.body.innerHTML = ""
  run.mockClear()
})

describe("runTerminalDockGesture", () => {
  it("captures the page, both slots and the two outlets under one transition", () => {
    mountShell()
    const apply = jest.fn()

    runTerminalDockGesture(apply)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    const options = run.mock.calls[0][0]
    const content = document.querySelector("[data-find-scope]")
    expect(options.scope).toBe(content)
    expect(options.captures.map((capture) => capture.name)).toEqual([
      "cognia-terminal-content",
      "cognia-terminal-bottom",
      "cognia-terminal-right",
      "cognia-terminal-outlet-center",
      "cognia-terminal-outlet-end",
    ])
    expect(options.captures[0].element).toBe(content)
    expect(options.captures[1].element?.getAttribute("data-position")).toBe("bottom")
    expect(options.captures[2].element?.getAttribute("data-position")).toBe("right")
    expect(options.captures[3].element?.getAttribute("data-title-bar-outlet")).toBe("center")
    expect(options.captures[4].element?.getAttribute("data-title-bar-outlet")).toBe("end")
  })

  it("applies directly outside the desktop shell, where no slot is drawn", () => {
    document.body.innerHTML = `<div data-find-scope></div>`
    const apply = jest.fn()

    runTerminalDockGesture(apply)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })
})

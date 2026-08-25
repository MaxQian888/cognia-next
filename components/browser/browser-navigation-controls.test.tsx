import { fireEvent, render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { BrowserNavigationControls } from "./browser-navigation-controls"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

it("routes back, forward, and reload through the supplied browser driver", () => {
  const onBack = jest.fn()
  const onForward = jest.fn()
  const onReload = jest.fn()
  render(
    <TooltipProvider>
      <BrowserNavigationControls onBack={onBack} onForward={onForward} onReload={onReload} />
    </TooltipProvider>
  )

  fireEvent.click(screen.getByRole("button", { name: "back" }))
  fireEvent.click(screen.getByRole("button", { name: "forward" }))
  fireEvent.click(screen.getByRole("button", { name: "reload" }))

  expect(onBack).toHaveBeenCalledTimes(1)
  expect(onForward).toHaveBeenCalledTimes(1)
  expect(onReload).toHaveBeenCalledTimes(1)
})

it("disables all navigation actions together", () => {
  render(
    <TooltipProvider>
      <BrowserNavigationControls
        disabled
        onBack={jest.fn()}
        onForward={jest.fn()}
        onReload={jest.fn()}
      />
    </TooltipProvider>
  )

  for (const name of ["back", "forward", "reload"]) {
    expect(screen.getByRole("button", { name })).toBeDisabled()
  }
})

// `browser_embed_stop` shipped with the subsystem but had no human-reachable
// caller: there was no way to halt a slow load short of navigating away.
describe("stop while loading", () => {
  it("turns reload into stop and calls onStop", () => {
    const onReload = jest.fn()
    const onStop = jest.fn()
    render(
      <TooltipProvider>
        <BrowserNavigationControls
          loading
          onBack={jest.fn()}
          onForward={jest.fn()}
          onReload={onReload}
          onStop={onStop}
        />
      </TooltipProvider>
    )
    expect(screen.queryByRole("button", { name: "reload" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "stop" }))
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onReload).not.toHaveBeenCalled()
  })

  it("stays a reload when the caller supplies no way to stop", () => {
    render(
      <TooltipProvider>
        <BrowserNavigationControls
          loading
          onBack={jest.fn()}
          onForward={jest.fn()}
          onReload={jest.fn()}
        />
      </TooltipProvider>
    )
    expect(screen.getByRole("button", { name: "reload" })).toBeInTheDocument()
  })

  it("keeps stop clickable even when reload is disabled", () => {
    const onStop = jest.fn()
    render(
      <TooltipProvider>
        <BrowserNavigationControls
          loading
          reloadDisabled
          onBack={jest.fn()}
          onForward={jest.fn()}
          onReload={jest.fn()}
          onStop={onStop}
        />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "stop" }))
    expect(onStop).toHaveBeenCalled()
  })
})

/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, within } from "@testing-library/react"
import {
  ComposerMenuCloseProvider,
  ComposerMenuPanel,
  ComposerMenuPanelsProvider,
  useComposerMenuClose,
  useComposerMenuPanels,
  type ComposerMenuPanels,
} from "./composer-menu-context"

function Probe() {
  const close = useComposerMenuClose()
  return <button type="button" data-testid="probe" onClick={close} />
}

describe("useComposerMenuClose", () => {
  it("is a no-op outside a provider", () => {
    render(<Probe />)
    // No menu above → nothing to close, and no throw.
    expect(() => fireEvent.click(screen.getByTestId("probe"))).not.toThrow()
  })

  it("invokes the host menu's close", () => {
    const closeMenu = jest.fn()
    render(
      <ComposerMenuCloseProvider value={closeMenu}>
        <Probe />
      </ComposerMenuCloseProvider>
    )
    fireEvent.click(screen.getByTestId("probe"))
    expect(closeMenu).toHaveBeenCalledTimes(1)
  })
})

function makePanels(over: Partial<ComposerMenuPanels> = {}): ComposerMenuPanels {
  return {
    activePanelId: null,
    slot: null,
    openPanel: jest.fn(),
    closePanel: jest.fn(),
    registerPanel: jest.fn(() => jest.fn()),
    ...over,
  }
}

function PanelsProbe() {
  const panels = useComposerMenuPanels()
  return <span data-testid="panels-probe">{panels === null ? "none" : "host"}</span>
}

describe("useComposerMenuPanels", () => {
  it("is null outside a host with in-place navigation, so rows keep their flyout", () => {
    render(<PanelsProbe />)
    expect(screen.getByTestId("panels-probe")).toHaveTextContent("none")
  })

  it("exposes the host's navigation inside a provider", () => {
    render(
      <ComposerMenuPanelsProvider value={makePanels()}>
        <PanelsProbe />
      </ComposerMenuPanelsProvider>
    )
    expect(screen.getByTestId("panels-probe")).toHaveTextContent("host")
  })
})

describe("ComposerMenuPanel", () => {
  it("renders nothing without a host", () => {
    render(
      <ComposerMenuPanel id="skills">
        <p data-testid="body" />
      </ComposerMenuPanel>
    )
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
  })

  it("registers with the host while mounted and unregisters on unmount", () => {
    const unregister = jest.fn()
    const registerPanel = jest.fn(() => unregister)
    const { unmount } = render(
      <ComposerMenuPanelsProvider value={makePanels({ registerPanel })}>
        <ComposerMenuPanel id="skills">
          <p data-testid="body" />
        </ComposerMenuPanel>
      </ComposerMenuPanelsProvider>
    )
    expect(registerPanel).toHaveBeenCalledWith("skills")
    expect(unregister).not.toHaveBeenCalled()
    unmount()
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it("stays out of the slot while another panel (or none) is showing", () => {
    const slot = document.createElement("div")
    document.body.appendChild(slot)
    render(
      <ComposerMenuPanelsProvider value={makePanels({ slot, activePanelId: "room-targets" })}>
        <ComposerMenuPanel id="skills">
          <p data-testid="body" />
        </ComposerMenuPanel>
      </ComposerMenuPanelsProvider>
    )
    expect(screen.queryByTestId("body")).not.toBeInTheDocument()
    slot.remove()
  })

  it("portals its body into the host's slot while it is the panel showing", () => {
    const slot = document.createElement("div")
    slot.setAttribute("data-testid", "slot")
    document.body.appendChild(slot)
    render(
      <ComposerMenuPanelsProvider value={makePanels({ slot, activePanelId: "skills" })}>
        <div data-testid="row-host">
          <ComposerMenuPanel id="skills">
            <p data-testid="body" />
          </ComposerMenuPanel>
        </div>
      </ComposerMenuPanelsProvider>
    )
    // In the host's slot, not next to the row that rendered it.
    expect(within(screen.getByTestId("slot")).getByTestId("body")).toBeInTheDocument()
    expect(within(screen.getByTestId("row-host")).queryByTestId("body")).toBeNull()
    slot.remove()
  })
})

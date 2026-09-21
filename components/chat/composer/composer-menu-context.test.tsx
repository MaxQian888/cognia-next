/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { ComposerMenuCloseProvider, useComposerMenuClose } from "./composer-menu-context"

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

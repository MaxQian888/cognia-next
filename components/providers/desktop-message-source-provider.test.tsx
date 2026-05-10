/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

import { DesktopMessageSourceProvider } from "./desktop-message-source-provider"

const installMock = jest.fn()
jest.mock("@/lib/companion/desktop-message-source", () => ({
  installDesktopMessageSource: () => installMock(),
}))

// Wave 2.2 added `installDesktopWriteSource` to the same provider so
// the desktop also handles the new mutating Wave 2 RPCs. Mock it
// alongside the message source so the lifecycle tests below stay
// focused on the provider's behaviour, not on which Tauri events the
// underlying source bridges to.
const installWriteMock = jest.fn()
jest.mock("@/lib/companion/desktop-write-source", () => ({
  installDesktopWriteSource: () => installWriteMock(),
}))

beforeEach(() => {
  installMock.mockReset()
  installWriteMock.mockReset()
  // The write-source mock returns a no-op teardown by default — tests
  // that care about its teardown override this explicitly.
  installWriteMock.mockResolvedValue(() => {})
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (window as { Capacitor?: unknown }).Capacitor
})

describe("<DesktopMessageSourceProvider />", () => {
  it("installs the message source on Tauri", async () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    const teardown = jest.fn()
    installMock.mockResolvedValueOnce(teardown)

    const { unmount } = render(
      <DesktopMessageSourceProvider>
        <div>child</div>
      </DesktopMessageSourceProvider>
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(installMock).toHaveBeenCalled()

    unmount()
    expect(teardown).toHaveBeenCalled()
  })

  it("does nothing on Capacitor", async () => {
    ;(window as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    }
    render(
      <DesktopMessageSourceProvider>
        <div>child</div>
      </DesktopMessageSourceProvider>
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(installMock).not.toHaveBeenCalled()
  })

  it("does nothing on web", async () => {
    render(
      <DesktopMessageSourceProvider>
        <div>child</div>
      </DesktopMessageSourceProvider>
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(installMock).not.toHaveBeenCalled()
  })

  it("tears down even when install resolves after unmount", async () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    let resolveInstall: (fn: () => void) => void = () => {}
    installMock.mockReturnValueOnce(
      new Promise<() => void>((r) => {
        resolveInstall = r
      })
    )
    const teardown = jest.fn()

    const { unmount } = render(
      <DesktopMessageSourceProvider>
        <div>child</div>
      </DesktopMessageSourceProvider>
    )

    unmount()
    resolveInstall(teardown)
    await new Promise((r) => setTimeout(r, 0))
    expect(teardown).toHaveBeenCalled()
  })
})

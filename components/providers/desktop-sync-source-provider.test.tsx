/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

import { DesktopSyncSourceProvider } from "./desktop-sync-source-provider"

const installMock = jest.fn()
jest.mock("@/lib/sync/desktop-sync-source", () => ({
  installDesktopSyncSource: () => installMock(),
}))

beforeEach(() => {
  installMock.mockReset()
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  delete (window as { Capacitor?: unknown }).Capacitor
})

describe("<DesktopSyncSourceProvider />", () => {
  it("installs the sync source on Tauri", async () => {
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {}
    const teardown = jest.fn()
    installMock.mockResolvedValueOnce(teardown)

    const { unmount } = render(
      <DesktopSyncSourceProvider>
        <div>child</div>
      </DesktopSyncSourceProvider>
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
      <DesktopSyncSourceProvider>
        <div>child</div>
      </DesktopSyncSourceProvider>
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(installMock).not.toHaveBeenCalled()
  })

  it("does nothing on web", async () => {
    render(
      <DesktopSyncSourceProvider>
        <div>child</div>
      </DesktopSyncSourceProvider>
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
      <DesktopSyncSourceProvider>
        <div>child</div>
      </DesktopSyncSourceProvider>
    )

    unmount()
    resolveInstall(teardown)
    await new Promise((r) => setTimeout(r, 0))
    expect(teardown).toHaveBeenCalled()
  })
})

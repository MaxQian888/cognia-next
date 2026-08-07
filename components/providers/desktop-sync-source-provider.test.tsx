/**
 * @jest-environment jsdom
 */

import { render } from "@testing-library/react"

import { DesktopSyncSourceProvider } from "./desktop-sync-source-provider"

const installMock = jest.fn()
jest.mock("@/lib/sync/desktop-sync-source", () => ({
  installDesktopSyncSource: () => installMock(),
}))
jest.mock("@/lib/mcp/sync-coordinator", () => ({ startMcpSyncCoordinator: jest.fn() }))
jest.mock("@/lib/mcp/credential-migrator", () => ({
  migrateMcpCredentials: jest.fn(async () => ({ items: [] })),
}))
jest.mock("@/lib/db/agent-team-projection", () => ({
  installAgentTeamProjection: () => jest.fn(),
}))

import { startMcpSyncCoordinator } from "@/lib/mcp/sync-coordinator"
import { migrateMcpCredentials } from "@/lib/mcp/credential-migrator"

const startMcpSyncCoordinatorMock = startMcpSyncCoordinator as jest.Mock
const migrateMcpCredentialsMock = migrateMcpCredentials as jest.Mock

beforeEach(() => {
  installMock.mockReset()
  startMcpSyncCoordinatorMock.mockClear()
  migrateMcpCredentialsMock.mockClear()
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
    expect(startMcpSyncCoordinatorMock).toHaveBeenCalled()
    expect(migrateMcpCredentialsMock).toHaveBeenCalled()

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

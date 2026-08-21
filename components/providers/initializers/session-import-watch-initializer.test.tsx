import { act, render } from "@testing-library/react"

import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { SessionImportWatchInitializer } from "./session-import-watch-initializer"

const start = jest.fn(async () => {})
const stop = jest.fn(async () => {})
const retarget = jest.fn()

jest.mock("@/lib/session-import/watch-controller", () => ({
  startSessionImportWatch: (...args: unknown[]) => start(...(args as [])),
  stopSessionImportWatch: (...args: unknown[]) => stop(...(args as [])),
  retargetSessionImportWatch: (...args: unknown[]) => retarget(...(args as [])),
}))

function seed(opts: { loaded?: boolean; enabled?: boolean; projectId?: string | null }) {
  useSettingsStore.setState({
    loaded: opts.loaded ?? true,
    settings: { id: "singleton", sessionImportWatch: { enabled: !!opts.enabled } } as never,
  })
  useProjectStore.setState({ activeProjectId: opts.projectId ?? null } as never)
}

beforeEach(() => {
  start.mockClear()
  stop.mockClear()
  retarget.mockClear()
})

afterEach(() => {
  useSettingsStore.setState({ settings: null, loaded: false })
})

describe("SessionImportWatchInitializer", () => {
  it("does nothing until settings have loaded", () => {
    // Acting on the pre-load `false` would look like the user turned live sync
    // off, and would fire a stop against a watcher that never started.
    seed({ loaded: false, enabled: true })
    render(<SessionImportWatchInitializer />)
    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it("starts the watch when the persisted preference is on", () => {
    seed({ enabled: true, projectId: "proj" })
    render(<SessionImportWatchInitializer />)
    expect(start).toHaveBeenCalledWith({ projectId: "proj" })
  })

  it("stops the watch when the preference is off", () => {
    seed({ enabled: false })
    render(<SessionImportWatchInitializer />)
    expect(stop).toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it("re-targets on a workspace switch instead of restarting", () => {
    seed({ enabled: true, projectId: "a" })
    const { rerender } = render(<SessionImportWatchInitializer />)
    expect(start).toHaveBeenLastCalledWith({ projectId: "a" })

    act(() => {
      useProjectStore.setState({ activeProjectId: "b" } as never)
    })
    rerender(<SessionImportWatchInitializer />)
    expect(start).toHaveBeenLastCalledWith({ projectId: "b" })
    // Re-pointed synchronously, ahead of the queued start: a start waiting
    // behind an in-flight one would keep importing into the old workspace
    // until its turn came.
    expect(retarget).toHaveBeenLastCalledWith("b")
    // No teardown between the two — the OS watch stays installed.
    expect(stop).not.toHaveBeenCalled()
  })

  it("stops the native watcher on unmount", () => {
    seed({ enabled: true })
    const { unmount } = render(<SessionImportWatchInitializer />)
    stop.mockClear()
    unmount()
    expect(stop).toHaveBeenCalled()
  })
})

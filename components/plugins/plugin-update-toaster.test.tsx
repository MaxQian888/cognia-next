/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}))

const toastMessage = jest.fn()
jest.mock("sonner", () => ({
  toast: { message: (...args: unknown[]) => toastMessage(...args) },
}))

import { act, render } from "@testing-library/react"

import { PLUGIN_UPDATES_AVAILABLE_EVENT } from "@/lib/plugin/lifecycle/updater"

import { PluginUpdateToaster } from "./plugin-update-toaster"

function fire(updates: Array<{ pluginId: string; latestVersion: string }>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(PLUGIN_UPDATES_AVAILABLE_EVENT, { detail: { updates } }))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
})

/**
 * `runAutoUpdate` has always dispatched this event under the notify-only
 * cadence the Policy tab presents as the default, and nothing in the repo
 * listened. Updates were found, the flag was raised, and the user was told
 * nothing.
 */
describe("PluginUpdateToaster", () => {
  it("toasts the count when updates are announced", () => {
    render(<PluginUpdateToaster />)
    fire([
      { pluginId: "a", latestVersion: "2.0.0" },
      { pluginId: "b", latestVersion: "1.1.0" },
    ])
    expect(toastMessage).toHaveBeenCalledTimes(1)
    expect(toastMessage.mock.calls[0][0]).toContain('"count":2')
  })

  it("says nothing for an empty announcement", () => {
    render(<PluginUpdateToaster />)
    fire([])
    expect(toastMessage).not.toHaveBeenCalled()
  })

  // The check runs on an interval, so the same finding arrives repeatedly.
  it("does not nag when the same set is re-announced", () => {
    render(<PluginUpdateToaster />)
    fire([{ pluginId: "a", latestVersion: "2.0.0" }])
    fire([{ pluginId: "a", latestVersion: "2.0.0" }])
    expect(toastMessage).toHaveBeenCalledTimes(1)
  })

  it("toasts again when a different version shows up", () => {
    render(<PluginUpdateToaster />)
    fire([{ pluginId: "a", latestVersion: "2.0.0" }])
    fire([{ pluginId: "a", latestVersion: "2.1.0" }])
    expect(toastMessage).toHaveBeenCalledTimes(2)
  })

  it("sends the user to the library already narrowed to the updates", () => {
    render(<PluginUpdateToaster />)
    fire([{ pluginId: "a", latestVersion: "2.0.0" }])
    const options = toastMessage.mock.calls[0][1] as { action: { onClick: () => void } }
    options.action.onClick()
    expect(pushMock).toHaveBeenCalledWith("/plugins?section=library&sub=updates")
  })

  it("stops listening once unmounted", () => {
    const { unmount } = render(<PluginUpdateToaster />)
    unmount()
    fire([{ pluginId: "a", latestVersion: "2.0.0" }])
    expect(toastMessage).not.toHaveBeenCalled()
  })
})

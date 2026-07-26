/**
 * @jest-environment jsdom
 */
import { act, render } from "@testing-library/react"

const toastFn = jest.fn()
jest.mock("sonner", () => ({
  toast: (...args: unknown[]) => toastFn(...args),
}))

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

import { ShellLayoutNotice } from "./shell-layout-notice"
import { useUIStore } from "@/stores/ui/ui-store"

beforeEach(() => {
  toastFn.mockClear()
  act(() => {
    useUIStore.setState({ chromeLayoutMigrated: false })
  })
})

it("stays silent on a fresh install, where nothing was migrated", () => {
  render(<ShellLayoutNotice />)
  expect(toastFn).not.toHaveBeenCalled()
})

it("explains the moved controls on the boot that migrated the layout", () => {
  act(() => {
    useUIStore.setState({ chromeLayoutMigrated: true })
  })
  render(<ShellLayoutNotice />)
  expect(toastFn).toHaveBeenCalledTimes(1)
  expect(toastFn.mock.calls[0][0]).toBe("desktop.shellLayoutNotice.title")
  expect(toastFn.mock.calls[0][1]).toMatchObject({
    description: "desktop.shellLayoutNotice.description",
  })
})

it("does not auto-dismiss — it fires during boot, when a timed toast is missed", () => {
  act(() => {
    useUIStore.setState({ chromeLayoutMigrated: true })
  })
  render(<ShellLayoutNotice />)
  expect(toastFn.mock.calls[0][1]).toMatchObject({ duration: Infinity, closeButton: true })
})

it("clears the flag so a remount cannot raise a second toast", () => {
  act(() => {
    useUIStore.setState({ chromeLayoutMigrated: true })
  })
  const { unmount } = render(<ShellLayoutNotice />)
  expect(useUIStore.getState().chromeLayoutMigrated).toBe(false)
  unmount()
  render(<ShellLayoutNotice />)
  expect(toastFn).toHaveBeenCalledTimes(1)
})

it("renders nothing into the tree", () => {
  const { container } = render(<ShellLayoutNotice />)
  expect(container).toBeEmptyDOMElement()
})

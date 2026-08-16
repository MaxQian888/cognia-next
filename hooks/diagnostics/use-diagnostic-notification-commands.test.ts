/** @jest-environment jsdom */

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
const dispose = jest.fn()
const install = jest.fn((_opts: { navigate: (path: string) => void }) => dispose)
jest.mock("@/lib/diagnostics/notification-commands", () => ({
  installDiagnosticNotificationCommands: (opts: { navigate: (path: string) => void }) =>
    install(opts),
}))

import { renderHook } from "@testing-library/react"

import { useDiagnosticNotificationCommands } from "./use-diagnostic-notification-commands"

it("installs the executors with router navigation and disposes them on unmount", () => {
  const { unmount } = renderHook(() => useDiagnosticNotificationCommands())
  expect(install).toHaveBeenCalledTimes(1)
  install.mock.calls[0][0].navigate("/logs")
  expect(push).toHaveBeenCalledWith("/logs")
  expect(dispose).not.toHaveBeenCalled()
  unmount()
  expect(dispose).toHaveBeenCalledTimes(1)
})

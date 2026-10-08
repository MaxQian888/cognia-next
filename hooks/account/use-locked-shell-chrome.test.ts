/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor } from "@testing-library/react"

let mockResolvedTheme: string | undefined = "dark"
let mockMobile = true
const mockSetTheme = jest.fn()
const mockRegister = jest.fn()
const mockStatusBar = jest.fn()
const mockNavBar = jest.fn()

jest.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: mockResolvedTheme,
    theme: mockResolvedTheme,
    setTheme: mockSetTheme,
  }),
}))
jest.mock("@/lib/capacitor/_shared", () => ({ isMobile: () => mockMobile }))
jest.mock("@/lib/capacitor/register-plugins", () => ({
  registerNativePlugins: () => mockRegister(),
}))
jest.mock("@/lib/capacitor/status-bar", () => ({
  syncWithTheme: (...args: unknown[]) => mockStatusBar(...args),
}))
jest.mock("@/lib/capacitor/navigation-bar", () => ({
  syncWithTheme: (...args: unknown[]) => mockNavBar(...args),
}))

import { useLockedAccountTheme, useLockedShellChrome } from "./use-locked-shell-chrome"
import { writeAccountTheme } from "@/lib/appearance/lock-screen-preferences"

beforeEach(() => {
  jest.clearAllMocks()
  window.localStorage.clear()
  mockResolvedTheme = "dark"
  mockMobile = true
  mockRegister.mockResolvedValue({ kind: "registered", registered: [], available: [] })
  document.documentElement.style.setProperty("--background", "#1c1c1f")
})

it("does not override the current mode for an account without a cached preference", () => {
  renderHook(() => useLockedAccountTheme("unseen"))
  expect(mockSetTheme).not.toHaveBeenCalled()
})

it("does not reapply an already matching account mode", () => {
  writeAccountTheme("alpha", "dark")
  renderHook(() => useLockedAccountTheme("alpha"))
  expect(mockSetTheme).not.toHaveBeenCalled()
})

afterEach(() => {
  document.documentElement.removeAttribute("style")
})

it("paints both native bars with the colour the gate is painting", async () => {
  renderHook(() => useLockedShellChrome())
  await waitFor(() => expect(mockStatusBar).toHaveBeenCalledWith("dark", "#1c1c1f"))
  expect(mockNavBar).toHaveBeenCalledWith("dark", "#1c1c1f")
  expect(mockRegister).toHaveBeenCalledTimes(1)
})

it("repaints when the variant changes", async () => {
  const { rerender } = renderHook(() => useLockedShellChrome())
  await waitFor(() => expect(mockStatusBar).toHaveBeenCalledTimes(1))
  document.documentElement.style.setProperty("--background", "#fafafa")
  mockResolvedTheme = "light"
  rerender()
  await waitFor(() => expect(mockStatusBar).toHaveBeenLastCalledWith("light", "#fafafa"))
})

it("does nothing off mobile or before the variant resolves", async () => {
  mockMobile = false
  renderHook(() => useLockedShellChrome())
  mockMobile = true
  mockResolvedTheme = undefined
  renderHook(() => useLockedShellChrome())
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(mockRegister).not.toHaveBeenCalled()
  expect(mockStatusBar).not.toHaveBeenCalled()
})

it("does not paint after unmounting mid-registration", async () => {
  let release!: () => void
  mockRegister.mockReturnValue(new Promise<void>((resolve) => (release = resolve)))
  const { unmount } = renderHook(() => useLockedShellChrome())
  unmount()
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(mockStatusBar).not.toHaveBeenCalled()
})

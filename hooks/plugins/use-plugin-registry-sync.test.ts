/**
 * @jest-environment jsdom
 */

const listPluginsMock = jest.fn()
const updatePluginMock = jest.fn()
const checkForUpdatesMock = jest.fn()
const toastSuccess = jest.fn()
const toastError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}))
jest.mock("@/lib/db/plugins", () => ({
  listPlugins: () => listPluginsMock(),
  updatePlugin: (id: string, patch: unknown) => updatePluginMock(id, patch),
}))
jest.mock("@/lib/plugin/package/marketplace", () => ({
  getPluginMarketplace: () => ({
    checkForUpdates: (rows: unknown) => checkForUpdatesMock(rows),
  }),
}))

import { act, renderHook } from "@testing-library/react"

import { usePluginRegistrySync } from "./use-plugin-registry-sync"

const row = (over: Record<string, unknown>) => ({
  id: "a",
  version: "1.0.0",
  type: "frontend",
  manifest: {},
  ...over,
})

beforeEach(() => {
  listPluginsMock.mockReset().mockResolvedValue([])
  updatePluginMock.mockReset().mockResolvedValue(undefined)
  checkForUpdatesMock.mockReset().mockResolvedValue([])
  toastSuccess.mockReset()
  toastError.mockReset()
})

describe("usePluginRegistrySync", () => {
  it("refreshes the catalog before asking about updates", async () => {
    const order: string[] = []
    const refresh = jest.fn(async () => {
      order.push("refresh")
    })
    checkForUpdatesMock.mockImplementation(async () => {
      order.push("check")
      return []
    })
    const { result } = renderHook(() => usePluginRegistrySync(refresh))
    await act(async () => {
      await result.current.sync()
    })
    expect(order).toEqual(["refresh", "check"])
  })

  it("stamps updateAvailable only on rows whose flag actually changes", async () => {
    listPluginsMock.mockResolvedValue([
      row({ id: "stale", manifest: {} }),
      row({ id: "already", manifest: { updateAvailable: true } }),
      row({ id: "fresh", manifest: {} }),
    ])
    checkForUpdatesMock.mockResolvedValue([
      { id: "stale", latestVersion: "2.0.0" },
      { id: "already", latestVersion: "2.0.0" },
    ])
    const { result } = renderHook(() => usePluginRegistrySync(jest.fn(async () => {})))
    await act(async () => {
      await result.current.sync()
    })
    expect(updatePluginMock).toHaveBeenCalledTimes(1)
    expect(updatePluginMock).toHaveBeenCalledWith("stale", {
      manifest: { updateAvailable: true },
    })
  })

  // Their ids can never resolve in the cognia registry, and asking would tell
  // it which extensions this user has. Open VSX answers for them instead.
  it("never sends VS Code extension ids to the cognia registry", async () => {
    listPluginsMock.mockResolvedValue([
      row({ id: "cognia.one" }),
      row({ id: "esbenp.prettier-vscode", type: "vscode-extension" }),
    ])
    const { result } = renderHook(() => usePluginRegistrySync(jest.fn(async () => {})))
    await act(async () => {
      await result.current.sync()
    })
    expect(checkForUpdatesMock).toHaveBeenCalledWith([{ id: "cognia.one", version: "1.0.0" }])
  })

  it("reports a failure as a toast rather than an unhandled rejection", async () => {
    const refresh = jest.fn(async () => {
      throw new Error("registry down")
    })
    const { result } = renderHook(() => usePluginRegistrySync(refresh))
    await act(async () => {
      await expect(result.current.sync()).resolves.toBeUndefined()
    })
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("registry down"))
    expect(result.current.syncing).toBe(false)
  })
})

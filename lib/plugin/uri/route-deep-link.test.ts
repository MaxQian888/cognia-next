const handleActivationEvent = jest.fn(async (_event: string) => {})
let managerAvailable = true
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => {
    if (!managerAvailable) throw new Error("not initialized")
    return { handleActivationEvent }
  },
}))

import { routePluginDeepLink } from "./route-deep-link"
import { __resetUriHandlersForTesting, registerUriHandler } from "./uri-handler-registry"
import type { ParsedDeepLink } from "./parse-deep-link"

afterEach(() => {
  __resetUriHandlersForTesting()
  handleActivationEvent.mockClear()
  managerAvailable = true
})

it("activates the addressed plugin, then hands it the link", async () => {
  const seen: ParsedDeepLink[] = []
  registerUriHandler("acme", (uri) => void seen.push(uri))
  await expect(routePluginDeepLink("cognia://plugin/acme/cb?code=1")).resolves.toBe(true)
  expect(handleActivationEvent).toHaveBeenCalledWith("onUri:acme")
  expect(seen).toEqual([
    expect.objectContaining({ pluginId: "acme", path: "cb", query: { code: "1" } }),
  ])
})

it("still dispatches when the manager is not up, and reports links nobody handles", async () => {
  managerAvailable = false
  const seen: string[] = []
  registerUriHandler("acme", (uri) => void seen.push(uri.path))
  await expect(routePluginDeepLink("cognia://plugin/acme/x")).resolves.toBe(true)
  expect(seen).toEqual(["x"])
  await expect(routePluginDeepLink("cognia://plugin/other/x")).resolves.toBe(false)
  managerAvailable = true
  await expect(routePluginDeepLink("https://example.com")).resolves.toBe(false)
  expect(handleActivationEvent).not.toHaveBeenCalled()
})

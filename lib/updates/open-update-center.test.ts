/** @jest-environment jsdom */
const requestOpenSettings = jest.fn()
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: { getState: () => ({ requestOpenSettings }) },
}))

import {
  __resetUpdateCenterOpen,
  openUpdateCenter,
  subscribeUpdateCenterOpen,
} from "./open-update-center"

afterEach(() => {
  __resetUpdateCenterOpen()
  requestOpenSettings.mockClear()
})

describe("openUpdateCenter", () => {
  it("notifies every listener", () => {
    const calls: string[] = []
    subscribeUpdateCenterOpen(() => calls.push("a"))
    subscribeUpdateCenterOpen(() => calls.push("b"))
    openUpdateCenter()
    expect(calls).toEqual(["a", "b"])
  })

  it("passes the focus key through", () => {
    const seen: unknown[] = []
    subscribeUpdateCenterOpen((o) => seen.push(o.focusKey))
    openUpdateCenter({ focusKey: "plugin:acme" })
    expect(seen).toEqual(["plugin:acme"])
  })

  it("replays a request made before anything was mounted", () => {
    openUpdateCenter({ focusKey: "desktop:app" })
    const seen: unknown[] = []
    subscribeUpdateCenterOpen((o) => seen.push(o.focusKey))
    expect(seen).toEqual(["desktop:app"])
  })

  it("replays a held request only once", () => {
    openUpdateCenter({ focusKey: "desktop:app" })
    subscribeUpdateCenterOpen(() => {})
    const second: unknown[] = []
    subscribeUpdateCenterOpen((o) => second.push(o))
    expect(second).toEqual([])
  })

  it("stops notifying after unsubscribe", () => {
    const calls: string[] = []
    const off = subscribeUpdateCenterOpen(() => calls.push("a"))
    off()
    openUpdateCenter()
    expect(calls).toEqual([])
  })
})

describe("navigation", () => {
  it("asks the settings shell for the Updates section, even with nothing mounted", async () => {
    openUpdateCenter()
    await Promise.resolve()
    await Promise.resolve()
    expect(requestOpenSettings).toHaveBeenCalledWith("updates")
  })
})

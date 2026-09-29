const listAll = jest.fn()
type Observer = { next: (value: unknown) => void; error: (error: unknown) => void }
const observers: Observer[] = []
const unsubscribe = jest.fn()
const liveQuery = jest.fn((query: () => unknown) => {
  void query
  return {
    subscribe: (observer: Observer) => {
      observers.push(observer)
      return { unsubscribe }
    },
  }
})
jest.mock("dexie", () => {
  const actual = jest.requireActual("dexie")
  const Base = actual.default
  class MockDexie extends Base {
    static liveQuery(query: () => unknown) {
      return liveQuery(query)
    }
  }
  return { ...actual, __esModule: true, default: MockDexie }
})
jest.mock("@/lib/db/browser-profiles", () => ({
  listAllBrowserDomainGrants: () => listAll(),
  normalizeBrowserGrantDomain: jest.requireActual("@/lib/db/browser-profiles")
    .normalizeBrowserGrantDomain,
}))

import {
  __resetBrowserDomainGrantsForTests,
  isBrowserDomainAuthorized,
  primeBrowserDomainGrants,
  setBrowserDomainGrantSnapshot,
  stopWatchingBrowserDomainGrants,
  watchBrowserDomainGrants,
} from "./domain-authorization"

beforeEach(() => {
  __resetBrowserDomainGrantsForTests()
  listAll.mockReset()
  liveQuery.mockClear()
  unsubscribe.mockClear()
  observers.length = 0
})

it("authorizes a granted domain and its subdomains", () => {
  setBrowserDomainGrantSnapshot([{ workspaceId: "w1", domain: "example.com" }])
  expect(isBrowserDomainAuthorized("https://example.com/a")).toBe(true)
  expect(isBrowserDomainAuthorized("https://docs.example.com")).toBe(true)
})

it("does not authorize a host that merely ends with the same text", () => {
  setBrowserDomainGrantSnapshot([{ workspaceId: "w1", domain: "example.com" }])
  expect(isBrowserDomainAuthorized("https://notexample.com")).toBe(false)
})

// Grants reach Dexie by two routes with different workspace ids: the settings
// card keys them by the active project, `connectBrowserSite` invents an
// `external-service:*` id. Both are the user's decision.
it("unions grants across both workspace-id shapes", () => {
  setBrowserDomainGrantSnapshot([
    { workspaceId: "project-1", domain: "one.dev" },
    { workspaceId: "external-service:browser:acme:abc", domain: "two.dev" },
  ])
  expect(isBrowserDomainAuthorized("https://one.dev")).toBe(true)
  expect(isBrowserDomainAuthorized("https://two.dev")).toBe(true)
})

it("never authorizes a non-public host", () => {
  setBrowserDomainGrantSnapshot([{ workspaceId: "w1", domain: "example.com" }])
  expect(isBrowserDomainAuthorized("http://localhost:3000")).toBe(false)
  expect(isBrowserDomainAuthorized("http://127.0.0.1:8080")).toBe(false)
  expect(isBrowserDomainAuthorized("not a url")).toBe(false)
})

it("authorizes nothing before the snapshot is warmed", () => {
  expect(isBrowserDomainAuthorized("https://example.com")).toBe(false)
})

it("warms from the database", async () => {
  listAll.mockResolvedValue([{ workspaceId: "w1", domain: "example.com" }])
  await expect(primeBrowserDomainGrants()).resolves.toEqual(["example.com"])
  expect(isBrowserDomainAuthorized("https://example.com")).toBe(true)
})

// No database (headless, first paint): authorizing nothing keeps every public
// origin on the embedded engine, which is the safe direction.
it("authorizes nothing when the database is unavailable", async () => {
  listAll.mockRejectedValue(new Error("no db"))
  await expect(primeBrowserDomainGrants()).resolves.toEqual([])
  expect(isBrowserDomainAuthorized("https://example.com")).toBe(false)
})

describe("live grants (ADR-0201)", () => {
  it("starts one subscription on prime and follows grants and revocations", async () => {
    listAll.mockResolvedValue([])
    await primeBrowserDomainGrants()
    await primeBrowserDomainGrants()
    expect(liveQuery).toHaveBeenCalledTimes(1)
    expect(isBrowserDomainAuthorized("https://example.com")).toBe(false)
    observers[0].next([{ workspaceId: "w1", domain: "example.com" }])
    expect(isBrowserDomainAuthorized("https://example.com")).toBe(true)
    observers[0].next([])
    expect(isBrowserDomainAuthorized("https://example.com")).toBe(false)
  })

  it("does not start watching when the first read fails", async () => {
    listAll.mockRejectedValue(new Error("no db"))
    await primeBrowserDomainGrants()
    expect(liveQuery).not.toHaveBeenCalled()
  })

  it("authorizes nothing and restarts cleanly after a live read error", () => {
    watchBrowserDomainGrants()
    observers[0].next([{ workspaceId: "w1", domain: "example.com" }])
    observers[0].error(new Error("closed"))
    expect(isBrowserDomainAuthorized("https://example.com")).toBe(false)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    watchBrowserDomainGrants()
    expect(liveQuery).toHaveBeenCalledTimes(2)
  })

  it("stops the subscription on request", () => {
    const stop = watchBrowserDomainGrants()
    stop()
    stopWatchingBrowserDomainGrants()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

const listAll = jest.fn()
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
} from "./domain-authorization"

beforeEach(() => {
  __resetBrowserDomainGrantsForTests()
  listAll.mockReset()
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

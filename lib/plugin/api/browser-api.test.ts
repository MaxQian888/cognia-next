jest.mock("@/lib/browser/agent-engine", () => ({ routeEngine: jest.fn(() => ({ engine: {} })) }))
jest.mock("@/lib/browser/domain-authorization", () => ({
  isBrowserDomainAuthorized: jest.fn(() => true),
  primeBrowserDomainGrants: jest.fn(async () => ["example.com"]),
}))
jest.mock("@/lib/db/browser-annotations", () => ({
  saveBrowserAnnotation: jest.fn(async () => undefined),
}))

import { routeEngine } from "@/lib/browser/agent-engine"
import {
  isBrowserDomainAuthorized,
  primeBrowserDomainGrants,
} from "@/lib/browser/domain-authorization"
import { saveBrowserAnnotation } from "@/lib/db/browser-annotations"
import { createBrowserAPI } from "./browser-api"

describe("createBrowserAPI", () => {
  it("delegates routing and domain consent to the host", async () => {
    const api = createBrowserAPI()

    api.routeEngine("https://example.com", { domainAuthorized: true })
    expect(routeEngine).toHaveBeenCalledWith("https://example.com", { domainAuthorized: true })
    expect(api.isDomainAuthorized("https://example.com")).toBe(true)
    expect(isBrowserDomainAuthorized).toHaveBeenCalledWith("https://example.com")
    await expect(api.primeDomainGrants()).resolves.toEqual(["example.com"])
    expect(primeBrowserDomainGrants).toHaveBeenCalledTimes(1)
  })

  it("persists annotations through the host database seam", async () => {
    const annotation = { id: "annotation-1" } as Parameters<
      ReturnType<typeof createBrowserAPI>["saveAnnotation"]
    >[0]

    await createBrowserAPI().saveAnnotation(annotation)

    expect(saveBrowserAnnotation).toHaveBeenCalledWith(annotation)
  })
})

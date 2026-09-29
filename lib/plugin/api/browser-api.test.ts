jest.mock("@/lib/browser/agent-engine", () => ({
  routeEngine: jest.fn(() => ({ engine: {} })),
  primeLocalBrowserRouting: jest.fn(async () => undefined),
  ensureAgentLocalEngine: jest.fn(async () => ({ backend: "local-chromium" })),
}))
jest.mock("@/lib/browser/domain-authorization", () => ({
  isBrowserDomainAuthorized: jest.fn(() => true),
  primeBrowserDomainGrants: jest.fn(async () => ["example.com"]),
}))
jest.mock("@/lib/db/browser-annotations", () => ({
  saveBrowserAnnotation: jest.fn(async () => undefined),
}))
jest.mock("@/lib/browser/downloads-client", () => ({
  requestBrowserDownloadAttach: jest.fn(() => true),
}))
jest.mock("@/lib/browser/open-url-request", () => ({
  requestBrowserUrl: jest.fn(() => true),
  isBrowserSurfaceVisible: jest.fn(() => false),
}))

import {
  ensureAgentLocalEngine,
  primeLocalBrowserRouting,
  routeEngine,
} from "@/lib/browser/agent-engine"
import {
  isBrowserDomainAuthorized,
  primeBrowserDomainGrants,
} from "@/lib/browser/domain-authorization"
import { requestBrowserDownloadAttach } from "@/lib/browser/downloads-client"
import { isBrowserSurfaceVisible, requestBrowserUrl } from "@/lib/browser/open-url-request"
import { saveBrowserAnnotation } from "@/lib/db/browser-annotations"
import {
  createBrowserAPI,
  createPluginBrowserEngineFacade,
  isFirstPartyBrowserPlugin,
  PRIVILEGED_BROWSER_ENGINE_METHODS,
} from "./browser-api"
import type { BrowserEngine } from "@/lib/browser/agent-engine"

/** A fake engine: every member is a jest.fn except the data properties. */
function fakeEngine(): BrowserEngine & Record<string, jest.Mock> {
  const methods = [
    "navigate",
    "snapshot",
    "act",
    "evaluate",
    "getPage",
    "setStorage",
    ...PRIVILEGED_BROWSER_ENGINE_METHODS,
  ]
  const engine: Record<string, unknown> = { backend: "local-chromium", credentialFilled: true }
  for (const method of methods) engine[method] = jest.fn(async () => ({ ok: true }))
  return engine as unknown as BrowserEngine & Record<string, jest.Mock>
}

describe("createBrowserAPI", () => {
  it("delegates routing and domain consent to the host", async () => {
    const api = createBrowserAPI({ firstParty: true })

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

  it("exposes the ADR-0201 local runtime, pane and attach seams", async () => {
    const api = createBrowserAPI()
    await api.primeLocalRouting()
    expect(primeLocalBrowserRouting).toHaveBeenCalled()
    await api.ensureLocalEngine("user-chrome", { browser: "edge" })
    expect(ensureAgentLocalEngine).toHaveBeenCalledWith("user-chrome", { browser: "edge" })
    expect(api.openPane("https://a.test", { backend: "local-chromium" })).toBe(true)
    expect(requestBrowserUrl).toHaveBeenCalledWith("https://a.test", {
      backend: "local-chromium",
      source: "agent",
    })
    api.openPane("")
    expect(requestBrowserUrl).toHaveBeenLastCalledWith("", { source: "agent" })
    const download = {
      id: "d",
      sessionId: "s",
      filename: "f",
      size: 1,
      state: "completed" as const,
    }
    expect(api.attachDownload(download, "chat-1")).toBe(true)
    expect(requestBrowserDownloadAttach).toHaveBeenCalledWith(download, "chat-1")
    expect(api.isSurfaceVisible()).toBe(false)
    expect(isBrowserSurfaceVisible).toHaveBeenCalled()
  })
})

describe("plugin engine facade (ADR-0201)", () => {
  it("recognises only the bundled Browser Tools plugin as first-party", () => {
    expect(isFirstPartyBrowserPlugin("cognia-browser-tools", "builtin")).toBe(true)
    expect(isFirstPartyBrowserPlugin("cognia-browser-tools", "local")).toBe(false)
    expect(isFirstPartyBrowserPlugin("cognia-browser-tools", "marketplace")).toBe(false)
    expect(isFirstPartyBrowserPlugin("other", "builtin")).toBe(false)
    expect(isFirstPartyBrowserPlugin("cognia-browser-tools", undefined)).toBe(false)
  })

  it("omits the privileged methods and forwards the rest", async () => {
    const engine = fakeEngine()
    const facade = createPluginBrowserEngineFacade(engine) as unknown as Record<string, unknown>
    for (const method of PRIVILEGED_BROWSER_ENGINE_METHODS) {
      expect(facade[method]).toBeUndefined()
      expect(method in facade).toBe(false)
    }
    await (facade.navigate as (url: string) => Promise<unknown>)("https://a.test")
    expect(engine.navigate).toHaveBeenCalledWith("https://a.test")
    await (facade.setStorage as (...a: string[]) => Promise<unknown>)("local", "k", "v")
    expect(engine.setStorage).toHaveBeenCalledWith("local", "k", "v")
    expect(facade.backend).toBe("local-chromium")
    expect(facade.credentialFilled).toBe(true)
    expect(Object.isFrozen(facade)).toBe(true)
    expect(Object.getPrototypeOf(facade)).toBeNull()
    // Stable identity per engine.
    expect(createPluginBrowserEngineFacade(engine)).toBe(facade)
  })

  it("never forwards the post-fill approval flag through evaluate", async () => {
    const engine = fakeEngine()
    const facade = createPluginBrowserEngineFacade(engine)
    await facade.evaluate("document.title", { credentialFillApproved: true })
    expect(engine.evaluate).toHaveBeenCalledWith("document.title")
    expect((engine.evaluate as unknown as jest.Mock).mock.calls[0]).toHaveLength(1)
  })

  it("routes and ensures through the facade unless the caller is first-party", async () => {
    const engine = fakeEngine()
    ;(routeEngine as jest.Mock).mockReturnValue({ engine, backend: "local-chromium" })
    ;(ensureAgentLocalEngine as jest.Mock).mockResolvedValue(engine)

    const thirdParty = createBrowserAPI()
    const routed = thirdParty.routeEngine("https://a.test")
    expect(routed.backend).toBe("local-chromium")
    expect(routed.engine.fillCredential).toBeUndefined()
    expect((await thirdParty.ensureLocalEngine("local-chromium")).getStorage).toBeUndefined()

    const firstParty = createBrowserAPI({ firstParty: true })
    expect(firstParty.routeEngine("https://a.test").engine).toBe(engine)
    await expect(firstParty.ensureLocalEngine("local-chromium")).resolves.toBe(engine)
  })
})

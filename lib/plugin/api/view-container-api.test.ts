/**
 * @jest-environment jsdom
 */

import {
  createViewContainerAPI,
  resolveOwnViewContainer,
  showViewContainer,
  ViewContainerOpenError,
  VIEW_CONTAINER_HOST_ROUTE,
} from "./view-container-api"
import { onPluginNavigationRequest, type PluginNavigationRequestDetail } from "./navigation-request"
import {
  registerViewContainer,
  __resetViewContainersForTesting,
} from "@/lib/plugin/registries/view-container-registry"
import { getPermissionGuard, resetPermissionGuard } from "@/lib/plugin/security"
import { PermissionError } from "@/lib/plugin/security/permission-guard"
import { useUIStore } from "@/stores/ui"

const mockConsent = jest.fn<Promise<boolean>, unknown[]>(async () => true)
jest.mock("@/lib/plugin/security/consent-broker", () => ({
  getPluginConsentBroker: () => ({ request: (...args: unknown[]) => mockConsent(...args) }),
}))

const OWNER = "acme.explorer"
const OTHER = "rival.plugin"

let navigations: PluginNavigationRequestDetail[]
let stopListening: () => void

beforeEach(() => {
  __resetViewContainersForTesting()
  resetPermissionGuard()
  mockConsent.mockReset()
  mockConsent.mockResolvedValue(true)
  useUIStore.getState().setSelectedGuild({ kind: "dm" })
  navigations = []
  stopListening = onPluginNavigationRequest((detail) => navigations.push(detail))
})

afterEach(() => {
  stopListening()
})

function grant(pluginId: string, permissions: string[] = ["extension:ui"]) {
  getPermissionGuard().registerPlugin(pluginId, permissions as never)
}

describe("createViewContainerAPI().openViewContainer", () => {
  it("opens the plugin's own container by its local id and routes home", async () => {
    grant(OWNER)
    registerViewContainer({ id: "tree", title: "Tree" }, { pluginId: OWNER })

    await createViewContainerAPI(OWNER).openViewContainer("tree")

    expect(useUIStore.getState().selectedGuild).toEqual({
      kind: "plugin-view",
      containerId: `${OWNER}:tree`,
    })
    expect(navigations).toEqual([{ pluginId: OWNER, href: VIEW_CONTAINER_HOST_ROUTE }])
  })

  it("accepts the namespaced id too", async () => {
    grant(OWNER)
    registerViewContainer({ id: "tree", title: "Tree" }, { pluginId: OWNER })

    await createViewContainerAPI(OWNER).openViewContainer(`${OWNER}:tree`)

    expect(useUIStore.getState().selectedGuild).toEqual({
      kind: "plugin-view",
      containerId: `${OWNER}:tree`,
    })
  })

  it("opens a `panel` container, which has no rail button", async () => {
    grant(OWNER)
    registerViewContainer({ id: "report", title: "Report", location: "panel" }, { pluginId: OWNER })

    await createViewContainerAPI(OWNER).openViewContainer("report")

    expect(useUIStore.getState().selectedGuild).toEqual({
      kind: "plugin-view",
      containerId: `${OWNER}:report`,
    })
    expect(navigations).toHaveLength(1)
  })

  it("rejects another plugin's container and leaves the shell alone", async () => {
    grant(OWNER)
    registerViewContainer({ id: "secret", title: "Secret" }, { pluginId: OTHER })

    const error = await createViewContainerAPI(OWNER)
      .openViewContainer(`${OTHER}:secret`)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ViewContainerOpenError)
    expect((error as ViewContainerOpenError).code).toBe("foreign")
    expect((error as Error).message).toContain(OTHER)
    expect(useUIStore.getState().selectedGuild).toEqual({ kind: "dm" })
    expect(navigations).toEqual([])
  })

  it("rejects an id nothing registered", async () => {
    grant(OWNER)

    await expect(createViewContainerAPI(OWNER).openViewContainer("missing")).rejects.toMatchObject({
      name: "ViewContainerOpenError",
      code: "not-registered",
      containerId: "missing",
    })
    expect(useUIStore.getState().selectedGuild).toEqual({ kind: "dm" })
    expect(navigations).toEqual([])
  })

  it("rejects an empty id", async () => {
    grant(OWNER)

    await expect(createViewContainerAPI(OWNER).openViewContainer("  ")).rejects.toMatchObject({
      code: "invalid-id",
    })
  })

  it("rejects (never throws synchronously) without extension:ui", async () => {
    grant(OWNER, [])
    registerViewContainer({ id: "tree", title: "Tree" }, { pluginId: OWNER })

    const pending = createViewContainerAPI(OWNER).openViewContainer("tree")

    await expect(pending).rejects.toBeInstanceOf(PermissionError)
    expect(useUIStore.getState().selectedGuild).toEqual({ kind: "dm" })
    expect(navigations).toEqual([])
  })

  it("rejects when the user set extension:ui to confirm and declines", async () => {
    grant(OWNER)
    getPermissionGuard().setTier(OWNER, "extension:ui", "confirm")
    mockConsent.mockResolvedValue(false)
    registerViewContainer({ id: "tree", title: "Tree" }, { pluginId: OWNER })

    await expect(createViewContainerAPI(OWNER).openViewContainer("tree")).rejects.toBeInstanceOf(
      PermissionError
    )
    expect(mockConsent).toHaveBeenCalled()
    expect(useUIStore.getState().selectedGuild).toEqual({ kind: "dm" })
  })
})

describe("resolveOwnViewContainer", () => {
  it("prefers the caller's own namespace over a foreign id of the same spelling", () => {
    registerViewContainer({ id: "c", title: "Theirs" }, { pluginId: "b" })
    registerViewContainer({ id: "b:c", title: "Mine" }, { pluginId: "a" })

    expect(resolveOwnViewContainer("a", "b:c").fullId).toBe("a:b:c")
  })

  it("names the owner when refusing a foreign container", () => {
    registerViewContainer({ id: "c", title: "Theirs" }, { pluginId: "b" })

    expect(() => resolveOwnViewContainer("a", "b:c")).toThrow(/belongs to plugin "b"/)
  })
})

describe("showViewContainer (host opener)", () => {
  it("selects the guild and routes through the given navigator", () => {
    registerViewContainer({ id: "report", title: "Report", location: "panel" }, { pluginId: OWNER })
    const navigate = jest.fn()

    const entry = showViewContainer(`${OWNER}:report`, navigate)

    expect(entry.fullId).toBe(`${OWNER}:report`)
    expect(useUIStore.getState().selectedGuild).toEqual({
      kind: "plugin-view",
      containerId: `${OWNER}:report`,
    })
    expect(navigate).toHaveBeenCalledWith("/")
  })

  it("throws for an unregistered id without touching the shell", () => {
    const navigate = jest.fn()

    expect(() => showViewContainer("gone:view", navigate)).toThrow(ViewContainerOpenError)
    expect(useUIStore.getState().selectedGuild).toEqual({ kind: "dm" })
    expect(navigate).not.toHaveBeenCalled()
  })
})

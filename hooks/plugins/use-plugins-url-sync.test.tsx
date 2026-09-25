/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

let search = new URLSearchParams()
const replace = jest.fn()
const push = jest.fn()
const router = { replace, push }
jest.mock("next/navigation", () => ({
  useSearchParams: () => search,
  useRouter: () => router,
  usePathname: () => "/plugins",
}))
jest.mock("@/lib/plugin/devtools/developer-mode", () => ({
  useDeveloperMode: jest.fn(() => false),
}))
jest.mock("sonner", () => ({ toast: { message: jest.fn() } }))

import { toast } from "sonner"
import { useDeveloperMode } from "@/lib/plugin/devtools/developer-mode"
import { usePluginsStore } from "@/stores/plugins"

import { usePluginsUrlSync } from "./use-plugins-url-sync"

beforeEach(() => {
  jest.clearAllMocks()
  ;(useDeveloperMode as jest.Mock).mockReturnValue(false)
  usePluginsStore.setState({
    activeSection: "discover",
    librarySubFilter: "all",
    governanceView: "permissions",
    detailSubTab: "configure",
    detailPluginId: null,
  })
})

function sync(query: string, options?: Parameters<typeof usePluginsUrlSync>[0]) {
  search = new URLSearchParams(query)
  return renderHook(() => usePluginsUrlSync(options))
}

describe("usePluginsUrlSync", () => {
  it("opens the named plugin on the Library and strips the one-shot param", () => {
    sync("plugin=web-tools&sub=enabled")
    const state = usePluginsStore.getState()
    expect(state.activeSection).toBe("library")
    expect(state.detailPluginId).toBe("web-tools")
    // A bare plugin link opens on the overview, not the last section.
    expect(state.detailSubTab).toBe("overview")
    expect(state.librarySubFilter).toBe("enabled")
    expect(replace).toHaveBeenCalledWith("/plugins?sub=enabled", { scroll: false })
  })

  it("expands the requested detail section for a plugin link", () => {
    sync("plugin=web-tools&subtab=capabilities")
    expect(usePluginsStore.getState().detailSubTab).toBe("capabilities")
    expect(replace).toHaveBeenCalledWith("/plugins", { scroll: false })
  })

  it("applies section / gov / subtab params", () => {
    sync("section=governance&gov=audit&subtab=data")
    const state = usePluginsStore.getState()
    expect(state.activeSection).toBe("governance")
    expect(state.governanceView).toBe("audit")
    expect(state.detailSubTab).toBe("data")
    expect(replace).not.toHaveBeenCalled()
  })

  it("ignores invalid values", () => {
    sync("section=nope&gov=nope&sub=nope&subtab=nope")
    const state = usePluginsStore.getState()
    expect(state.activeSection).toBe("discover")
    expect(state.governanceView).toBe("permissions")
  })

  it("does not select a section the shell disallows", () => {
    sync("section=agent-packages", { isSectionAllowed: (s) => s !== "agent-packages" })
    expect(usePluginsStore.getState().activeSection).toBe("discover")
  })

  it("translates a legacy ?tab= link", () => {
    sync("tab=configure")
    expect(replace).toHaveBeenCalledWith(
      "/plugins?section=library&sub=configurable&subtab=configure",
      { scroll: false }
    )
  })

  it("redirects devtools to the Library when Developer Mode is off", () => {
    sync("section=devtools")
    expect(usePluginsStore.getState().activeSection).toBe("library")
    expect(replace).toHaveBeenCalledWith("/plugins?section=library", { scroll: false })
    expect(toast.message).toHaveBeenCalled()
  })

  it("honours devtools when Developer Mode is on", () => {
    ;(useDeveloperMode as jest.Mock).mockReturnValue(true)
    sync("section=devtools")
    expect(usePluginsStore.getState().activeSection).toBe("devtools")
  })
})

import { render, cleanup } from "@testing-library/react"
import { ContextKeysInitializer } from "./context-keys-initializer"
import {
  getContextKeySnapshot,
  __resetContextKeysForTesting,
} from "@/lib/plugin/context-keys/context-key-store"

// ── Store mocks: each hook applies the caller's selector to a fixed state ──

const chatState = { status: "idle", activeSessionId: "s1", messages: [{}, {}] }
const uiState = { selectedGuild: { kind: "team" } }
const projectState = { activeProjectId: "p1" }
const pluginState = {
  plugins: {
    alpha: { status: "enabled" },
    beta: { status: "disabled" },
  },
}

jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector(chatState),
}))
jest.mock("@/stores/ui", () => ({
  useUIStore: (selector: (s: unknown) => unknown) => selector(uiState),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) => selector(projectState),
}))
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: (selector: (s: unknown) => unknown) => selector(pluginState),
}))
jest.mock("next/navigation", () => ({
  usePathname: () => "/settings/plugins",
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

describe("ContextKeysInitializer", () => {
  beforeEach(() => __resetContextKeysForTesting())
  afterEach(() => cleanup())

  it("projects live store state into the context-key store", () => {
    render(<ContextKeysInitializer />)
    const keys = getContextKeySnapshot()
    expect(keys).toMatchObject({
      "platform.tauri": true,
      "platform.web": false,
      "chat.active": true,
      "chat.streaming": false,
      "chat.hasMessages": true,
      "project.active": true,
      "view.team": true,
      "view.dm": false,
      "agent.teamActive": true,
      "plugin.alpha.enabled": true,
      "plugin.beta.enabled": false,
    })
  })

  it("sets a route key from the first pathname segment", () => {
    render(<ContextKeysInitializer />)
    expect(getContextKeySnapshot()["route.settings"]).toBe(true)
  })

  it("clears the route key on unmount", () => {
    const { unmount } = render(<ContextKeysInitializer />)
    expect(getContextKeySnapshot()["route.settings"]).toBe(true)
    unmount()
    expect(getContextKeySnapshot()["route.settings"]).toBe(false)
  })

  it("renders nothing (it is a pure side-effect initializer)", () => {
    const { container } = render(<ContextKeysInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})

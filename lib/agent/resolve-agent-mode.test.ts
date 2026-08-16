/** @jest-environment jsdom */

import { resolveActiveAgentMode } from "./resolve-agent-mode"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

const CUSTOM = {
  id: "custom-1",
  type: "custom",
  name: "Custom",
  description: "",
  icon: "Bot",
  isBuiltIn: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

describe("resolveActiveAgentMode", () => {
  afterEach(() => {
    useCustomModeStore.setState({ customModes: {} })
    jest.restoreAllMocks()
  })

  it("returns undefined for a missing id", () => {
    expect(resolveActiveAgentMode(undefined)).toBeUndefined()
    expect(resolveActiveAgentMode(null)).toBeUndefined()
    expect(resolveActiveAgentMode("")).toBeUndefined()
  })

  it("resolves a built-in mode", () => {
    expect(resolveActiveAgentMode("general")?.name).toBe("General Assistant")
    expect(resolveActiveAgentMode("plan")?.permissionMode).toBe("plan")
  })

  it("resolves a user's custom mode", () => {
    useCustomModeStore.setState({ customModes: { "custom-1": CUSTOM } as never })

    expect(resolveActiveAgentMode("custom-1")?.name).toBe("Custom")
  })

  it("resolves a plugin-contributed mode", () => {
    jest.spyOn(usePluginStore.getState(), "getAllModes").mockReturnValue([
      {
        id: "cognia-work:work",
        type: "custom",
        name: "Work",
        description: "",
        icon: "BriefcaseBusiness",
      },
    ])

    expect(resolveActiveAgentMode("cognia-work:work")?.name).toBe("Work")
  })

  // The precedence is the point of the function: a custom mode must not be able
  // to shadow a built-in id the rest of the app resolves differently.
  it("prefers the built-in registry over a colliding custom mode", () => {
    useCustomModeStore.setState({
      customModes: { general: { ...CUSTOM, id: "general", name: "Impostor" } } as never,
    })

    expect(resolveActiveAgentMode("general")?.name).toBe("General Assistant")
  })

  it("returns undefined for an id no source knows", () => {
    expect(resolveActiveAgentMode("ghost")).toBeUndefined()
  })
})

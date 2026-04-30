/**
 * @jest-environment jsdom
 */
import { useCustomModeStore } from "./store"

jest.mock("@/lib/logger", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return { loggers: { agent: { ...child, child: () => child } } }
})

describe("useCustomModeStore persistence", () => {
  beforeEach(() => {
    useCustomModeStore.getState().reset()
    window.localStorage.clear()
  })

  it("partializes Date fields into ISO strings on write", () => {
    const created = useCustomModeStore.getState().createMode({ name: "P" })
    useCustomModeStore.getState().recordModeUsage(created.id)
    const stored = window.localStorage.getItem("cognia-custom-modes")
    expect(stored).not.toBeNull()
    const parsed = JSON.parse(stored as string)
    const mode = parsed.state.customModes[created.id]
    expect(typeof mode.createdAt).toBe("string")
    expect(typeof mode.updatedAt).toBe("string")
    expect(typeof mode.lastUsedAt).toBe("string")
  })

  it("rehydrates Date strings back into Date objects", async () => {
    const past = new Date("2024-01-01T00:00:00.000Z")
    window.localStorage.setItem(
      "cognia-custom-modes",
      JSON.stringify({
        version: 0,
        state: {
          customModes: {
            seed: {
              id: "seed",
              type: "custom",
              isBuiltIn: false,
              name: "Seed",
              description: "",
              icon: "Bot",
              systemPrompt: "",
              tools: [],
              outputFormat: "text",
              customConfig: {},
              createdAt: past.toISOString(),
              updatedAt: past.toISOString(),
              lastUsedAt: past.toISOString(),
            },
          },
          activeModeId: null,
          isGenerating: false,
          generationError: null,
        },
      })
    )
    await useCustomModeStore.persist.rehydrate()
    const seed = useCustomModeStore.getState().customModes["seed"]
    expect(seed.createdAt).toBeInstanceOf(Date)
    expect(seed.updatedAt).toBeInstanceOf(Date)
    expect(seed.lastUsedAt).toBeInstanceOf(Date)
  })

  it("partialize handles a mode that already has Date instances", () => {
    // Create a mode and inject Date instances directly via setState (bypasses createMode's normalization)
    const mode = useCustomModeStore.getState().createMode({ name: "Direct" })
    useCustomModeStore.setState((state) => ({
      customModes: {
        ...state.customModes,
        [mode.id]: {
          ...mode,
          createdAt: new Date(mode.createdAt),
          updatedAt: new Date(mode.updatedAt),
          lastUsedAt: undefined,
        },
      },
    }))
    // Force the persist storage to flush by mutating something else
    useCustomModeStore.getState().setActiveMode(null)
    const stored = window.localStorage.getItem("cognia-custom-modes")
    const parsed = JSON.parse(stored as string)
    expect(typeof parsed.state.customModes[mode.id].createdAt).toBe("string")
    expect(parsed.state.customModes[mode.id].lastUsedAt).toBeUndefined()
  })

  it("partialize passes pre-stringified Date fields through unchanged", () => {
    // Inject already-string fields into state to exercise the non-Date branch
    const past = "2024-06-01T12:00:00.000Z"
    useCustomModeStore.setState({
      customModes: {
        seed: {
          id: "seed",
          type: "custom",
          isBuiltIn: false,
          name: "Seed",
          description: "",
          icon: "Bot",
          systemPrompt: "",
          tools: [],
          outputFormat: "text",
          customConfig: {},
          createdAt: past as unknown as Date,
          updatedAt: past as unknown as Date,
          lastUsedAt: past as unknown as Date,
        },
      },
    })
    // Trigger a flush
    useCustomModeStore.getState().setActiveMode(null)
    const stored = window.localStorage.getItem("cognia-custom-modes")
    const parsed = JSON.parse(stored as string)
    expect(parsed.state.customModes.seed.createdAt).toBe(past)
    expect(parsed.state.customModes.seed.updatedAt).toBe(past)
    expect(parsed.state.customModes.seed.lastUsedAt).toBe(past)
  })
})

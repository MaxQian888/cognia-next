import { useArtifactStore } from "./artifact"
import { useSettingsStore } from "./settings"

describe("stores root barrel — synthetic adapters", () => {
  describe("useNativeStore.isDesktop", () => {
    afterEach(() => {
      jest.resetModules()
      jest.dontMock("@/lib/tauri")
    })

    it("reports true when @/lib/tauri.isTauri() returns true", () => {
      jest.isolateModules(() => {
        jest.doMock("@/lib/tauri", () => ({ isTauri: () => true }))
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { useNativeStore } = require("./index")
        expect(useNativeStore.getState().isDesktop).toBe(true)
      })
    })

    it("reports false when @/lib/tauri.isTauri() returns false", () => {
      jest.isolateModules(() => {
        jest.doMock("@/lib/tauri", () => ({ isTauri: () => false }))
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { useNativeStore } = require("./index")
        expect(useNativeStore.getState().isDesktop).toBe(false)
      })
    })
  })

  describe("useSessionStore.getActiveSession()", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useSessionStore } = require("./index") as typeof import("./index")

    afterEach(() => {
      jest.restoreAllMocks()
      useSettingsStore.setState({ settings: null })
    })

    it("returns null when artifact currentSessionId is missing", () => {
      jest.spyOn(useArtifactStore, "getState").mockReturnValue({
        // No currentSessionId field — adapter must default to null
      } as ReturnType<typeof useArtifactStore.getState>)
      expect(useSessionStore.getState().getActiveSession()).toBeNull()
    })

    it("synthesises a session shape from artifact + settings state", () => {
      jest.spyOn(useArtifactStore, "getState").mockReturnValue({
        currentSessionId: "session-xyz",
      } as unknown as ReturnType<typeof useArtifactStore.getState>)
      useSettingsStore.setState({
        settings: {
          id: "singleton",
          permissionMode: "default",
          alwaysAllowTools: [],
          builtinTools: {
            fileExtras: true,
            git: true,
            process: false,
            environment: true,
            shellAdvanced: false,
          },
          defaultModel: "claude-haiku",
          apiKey: "sk-test",
        },
      })
      expect(useSessionStore.getState().getActiveSession()).toEqual({
        id: "session-xyz",
        provider: "anthropic",
        model: "claude-haiku",
        apiKey: "sk-test",
      })
    })

    it("leaves model and apiKey undefined when settings is null", () => {
      jest.spyOn(useArtifactStore, "getState").mockReturnValue({
        currentSessionId: "session-1",
      } as unknown as ReturnType<typeof useArtifactStore.getState>)
      useSettingsStore.setState({ settings: null })
      expect(useSessionStore.getState().getActiveSession()).toEqual({
        id: "session-1",
        provider: "anthropic",
        model: undefined,
        apiKey: undefined,
      })
    })
  })

  describe("barrel re-exports", () => {
    it("exposes the documented store hooks", () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./index")
      expect(typeof mod.useArtifactStore).toBe("function")
      expect(typeof mod.useChatStore).toBe("function")
      expect(typeof mod.useSettingsStore).toBe("function")
      expect(typeof mod.useUIStore).toBe("function")
      expect(typeof mod.useCanvasSettingsStore).toBe("function")
      expect(typeof mod.useChunkedDocumentStore).toBe("function")
      expect(typeof mod.useCommentStore).toBe("function")
      expect(typeof mod.useKeybindingStore).toBe("function")
      expect(typeof mod.useSessionStore).toBe("function")
      expect(typeof mod.useNativeStore).toBe("function")
    })
  })
})

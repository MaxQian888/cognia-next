/**
 * Tests for A2UI Store
 */

import { act } from "@testing-library/react"
import {
  useA2UIStore,
  selectSurface,
  selectActiveSurface,
  selectSurfaceComponents,
  selectSurfaceDataModel,
  selectIsSurfaceLoading,
  selectSurfaceError,
  selectEventHistory,
  selectRecentEvents,
} from "./a2ui-store"
import type { A2UIServerMessage } from "@/types/a2ui/schema"

// Mock dependencies
jest.mock("@/lib/a2ui/parser", () => ({
  isCreateSurfaceMessage: (msg: { type: string }) => msg.type === "createSurface",
  isUpdateComponentsMessage: (msg: { type: string }) => msg.type === "updateComponents",
  isUpdateDataModelMessage: (msg: { type: string }) => msg.type === "dataModelUpdate",
  isDeleteSurfaceMessage: (msg: { type: string }) => msg.type === "deleteSurface",
  isSurfaceReadyMessage: (msg: { type: string }) => msg.type === "surfaceReady",
  isConnectorActionMessage: (msg: { type: string }) => msg.type === "connectorAction",
}))

jest.mock("@/lib/a2ui/data-model", () => ({
  setValueByPath: jest.fn((obj, path, value) => {
    const result = { ...obj }
    const segments = path.split("/").filter(Boolean)
    let current = result
    for (let i = 0; i < segments.length - 1; i++) {
      current[segments[i]] = current[segments[i]] || {}
      current = current[segments[i]]
    }
    current[segments[segments.length - 1]] = value
    return result
  }),
  getValueByPath: jest.fn((obj, path) => {
    const segments = path.split("/").filter(Boolean)
    let current = obj
    for (const segment of segments) {
      if (current && typeof current === "object") {
        current = current[segment]
      } else {
        return undefined
      }
    }
    return current
  }),
  deepMerge: jest.fn((target, source) => ({ ...target, ...source })),
  deepClone: jest.fn((obj) => JSON.parse(JSON.stringify(obj))),
}))

jest.mock("@/lib/a2ui/events", () => ({
  globalEventEmitter: { emitAction: jest.fn(), emitDataChange: jest.fn() },
  createUserAction: jest.fn((surfaceId, action, componentId, data) => ({
    type: "user_action",
    surfaceId,
    action,
    componentId,
    data,
    timestamp: Date.now(),
  })),
  createDataModelChange: jest.fn((surfaceId, path, value) => ({
    type: "data_model_change",
    surfaceId,
    path,
    value,
    timestamp: Date.now(),
  })),
}))

describe("useA2UIStore", () => {
  beforeEach(() => {
    localStorage.clear()
    act(() => {
      useA2UIStore.getState().reset()
    })
  })

  describe("initial state", () => {
    it("has correct initial state", () => {
      const state = useA2UIStore.getState()
      expect(state.surfaces).toEqual({})
      expect(state.activeSurfaceId).toBeNull()
      expect(state.eventHistory).toEqual([])
    })
  })

  describe("createSurface", () => {
    it("should create a new surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog", { title: "Test" })
      })
      const state = useA2UIStore.getState()
      expect(state.surfaces["surface-1"]).toBeDefined()
      expect(state.surfaces["surface-1"].type).toBe("dialog")
      expect(state.activeSurfaceId).toBe("surface-1")
    })
  })

  describe("deleteSurface", () => {
    it("should delete a surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().deleteSurface("surface-1")
      })
      expect(useA2UIStore.getState().surfaces["surface-1"]).toBeUndefined()
    })

    it("should clear streaming state for deleted surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setSurfaceStreaming("surface-1", true)
        useA2UIStore.getState().deleteSurface("surface-1")
      })

      expect(useA2UIStore.getState().streamingSurfaces["surface-1"]).toBeUndefined()
    })
  })

  describe("updateComponents", () => {
    it("should update components on a surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore
          .getState()
          .updateComponents("surface-1", [
            { id: "comp-1", type: "Button", props: { label: "Click" } } as never,
          ])
      })
      expect(useA2UIStore.getState().surfaces["surface-1"].components["comp-1"]).toBeDefined()
    })
  })

  describe("updateDataModel", () => {
    it("should update data model", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().updateDataModel("surface-1", { name: "John" })
      })
      expect(useA2UIStore.getState().surfaces["surface-1"].dataModel.name).toBe("John")
    })
  })

  describe("setSurfaceReady", () => {
    it("should set surface as ready", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setSurfaceReady("surface-1")
      })
      expect(useA2UIStore.getState().surfaces["surface-1"].ready).toBe(true)
    })
  })

  describe("setError", () => {
    it("should set error for surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setError("surface-1", "Error")
      })
      expect(useA2UIStore.getState().errors["surface-1"]).toBe("Error")
    })
  })

  describe("emitAction", () => {
    it("should add action to event history", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().emitAction("surface-1", "click", "button-1")
      })
      expect(useA2UIStore.getState().eventHistory).toHaveLength(1)
    })
  })

  describe("processMessage: connectorAction", () => {
    it("injects an IM callback as a userAction (value carries the action id)", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().processMessage({
          type: "connectorAction",
          surfaceId: "surface-1",
          componentId: "approve-btn",
          actionType: "button",
          value: "approve",
          platform: "slack",
          triggerId: "t1",
          conversationKey: "ck",
          payload: { note: "ok" },
        })
      })
      const history = useA2UIStore.getState().eventHistory
      expect(history).toHaveLength(1)
      const event = history[0] as {
        action: string
        componentId: string
        data: Record<string, unknown>
      }
      expect(event.action).toBe("approve")
      expect(event.componentId).toBe("approve-btn")
      expect(event.data).toMatchObject({
        source: "connector",
        actionType: "button",
        value: "approve",
        platform: "slack",
        triggerId: "t1",
        conversationKey: "ck",
        payload: { note: "ok" },
      })
    })

    it("falls back to actionType when value is empty (submit/dismiss) and tolerates no componentId", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().processMessage({
          type: "connectorAction",
          surfaceId: "surface-1",
          actionType: "dismiss",
        })
      })
      const event = useA2UIStore.getState().eventHistory[0] as {
        action: string
        componentId: string
        data: Record<string, unknown>
      }
      expect(event.action).toBe("dismiss")
      expect(event.componentId).toBe("")
      expect(event.data).toEqual({ source: "connector", actionType: "dismiss" })
    })
  })

  describe("selectors", () => {
    it("should select surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
      })
      expect(selectSurface("surface-1")(useA2UIStore.getState())).toBeDefined()
    })

    it("should select active surface", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
      })
      expect(selectActiveSurface(useA2UIStore.getState())).toBeDefined()
    })

    it("should select surface components", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
      })
      expect(selectSurfaceComponents("surface-1")(useA2UIStore.getState())).toEqual({})
    })

    it("should select surface data model", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
      })
      expect(selectSurfaceDataModel("surface-1")(useA2UIStore.getState())).toEqual({})
    })

    it("should select surface loading state", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setSurfaceLoading("surface-1", true)
      })
      expect(selectIsSurfaceLoading("surface-1")(useA2UIStore.getState())).toBe(true)
    })

    it("should select surface error", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().setError("surface-1", "Test error")
      })
      expect(selectSurfaceError("surface-1")(useA2UIStore.getState())).toBe("Test error")
    })

    it("should select event history", () => {
      expect(selectEventHistory(useA2UIStore.getState())).toEqual([])
    })

    it("should select recent events", () => {
      expect(selectRecentEvents(5)(useA2UIStore.getState())).toEqual([])
    })
  })

  describe("reset", () => {
    it("should reset to initial state", () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.getState().reset()
      })
      expect(useA2UIStore.getState().surfaces).toEqual({})
      expect(useA2UIStore.getState().activeSurfaceId).toBeNull()
    })
  })

  describe("processMessageStream", () => {
    it("should clear streaming flags even when message processing throws", async () => {
      act(() => {
        useA2UIStore.getState().createSurface("surface-1", "dialog")
        useA2UIStore.setState({
          processMessage: () => {
            throw new Error("stream failure")
          },
        } as Partial<ReturnType<typeof useA2UIStore.getState>>)
      })

      await expect(
        useA2UIStore
          .getState()
          .processMessageStream(
            [{ type: "updateComponents", surfaceId: "surface-1", components: [] }],
            0
          )
      ).rejects.toThrow("stream failure")

      expect(useA2UIStore.getState().streamingSurfaces["surface-1"]).toBeUndefined()
    })
  })

  describe("persist rehydrate normalization", () => {
    it("should normalize metadata-only surface to non-ready state", async () => {
      localStorage.setItem(
        "cognia-a2ui-surfaces",
        JSON.stringify({
          state: {
            surfaces: {
              "surface-meta": {
                id: "surface-meta",
                type: "inline",
                rootId: "root",
                createdAt: 1,
                updatedAt: 2,
                ready: true,
              },
            },
            activeSurfaceId: "surface-meta",
          },
          version: 2,
        })
      )

      await act(async () => {
        await (
          useA2UIStore as unknown as { persist: { rehydrate: () => Promise<void> } }
        ).persist.rehydrate()
      })

      const surface = useA2UIStore.getState().surfaces["surface-meta"]
      expect(surface).toBeDefined()
      expect(surface.ready).toBe(false)
      expect(surface.components).toEqual({})
      expect(useA2UIStore.getState().activeSurfaceId).toBe("surface-meta")
    })
  })
})

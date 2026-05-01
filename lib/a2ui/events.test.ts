/**
 * A2UI Events Tests
 */

import {
  A2UIEventEmitter,
  globalEventEmitter,
  createUserAction,
  createDataModelChange,
  formatActionForAI,
  formatDataChangeForAI,
  batchEventsForAI,
  ActionTypes,
} from "./events"

describe("A2UI Events", () => {
  describe("A2UIEventEmitter", () => {
    it("should create an event emitter", () => {
      const emitter = new A2UIEventEmitter()
      expect(emitter).toBeDefined()
      expect(typeof emitter.emitAction).toBe("function")
      expect(typeof emitter.emitDataChange).toBe("function")
      expect(typeof emitter.onAction).toBe("function")
      expect(typeof emitter.onDataChange).toBe("function")
    })

    it("should emit and receive action events", () => {
      const emitter = new A2UIEventEmitter()
      const mockHandler = jest.fn()

      emitter.onAction(mockHandler)

      const action = createUserAction("surface-1", "submit", "btn-1", { value: "test" })
      emitter.emitAction(action)

      expect(mockHandler).toHaveBeenCalledWith(action)
    })

    it("should emit and receive data change events", () => {
      const emitter = new A2UIEventEmitter()
      const mockHandler = jest.fn()

      emitter.onDataChange(mockHandler)

      const change = createDataModelChange("surface-1", "/name", "John")
      emitter.emitDataChange(change)

      expect(mockHandler).toHaveBeenCalledWith(change)
    })

    it("should unsubscribe from events", () => {
      const emitter = new A2UIEventEmitter()
      const mockHandler = jest.fn()

      const unsubscribe = emitter.onAction(mockHandler)
      unsubscribe()

      const action = createUserAction("surface-1", "submit", "btn-1")
      emitter.emitAction(action)

      expect(mockHandler).not.toHaveBeenCalled()
    })
  })

  describe("globalEventEmitter", () => {
    it("should be a singleton", () => {
      expect(globalEventEmitter).toBeDefined()
      expect(typeof globalEventEmitter.emitAction).toBe("function")
    })
  })

  describe("createUserAction", () => {
    it("should create a user action with required fields", () => {
      const action = createUserAction("surface-1", "click", "btn-1")

      expect(action.type).toBe("userAction")
      expect(action.surfaceId).toBe("surface-1")
      expect(action.action).toBe("click")
      expect(action.componentId).toBe("btn-1")
      expect(action.timestamp).toBeDefined()
    })

    it("should include optional data", () => {
      const action = createUserAction("surface-1", "submit", "form-1", {
        formData: { name: "John" },
      })

      expect(action.data).toEqual({ formData: { name: "John" } })
    })
  })

  describe("createDataModelChange", () => {
    it("should create a data model change event", () => {
      const change = createDataModelChange("surface-1", "/name", "John")

      expect(change.type).toBe("dataModelChange")
      expect(change.surfaceId).toBe("surface-1")
      expect(change.path).toBe("/name")
      expect(change.value).toBe("John")
      expect(change.timestamp).toBeDefined()
    })
  })

  describe("formatActionForAI", () => {
    it("should format action for AI consumption", () => {
      const action = createUserAction("s1", "click", "btn-1")
      const formatted = formatActionForAI(action)

      expect(formatted).toContain("click")
      expect(formatted).toContain("User action")
    })

    it("should include action data in formatted output", () => {
      const action = createUserAction("s1", "submit", "form-1", { name: "John" })
      const formatted = formatActionForAI(action)

      expect(formatted).toContain("submit")
      expect(formatted).toContain("John")
    })
  })

  describe("formatDataChangeForAI", () => {
    it("should format data change for AI consumption", () => {
      const change = createDataModelChange("s1", "/name", "John")
      const formatted = formatDataChangeForAI(change)

      expect(formatted).toContain("/name")
      expect(formatted).toContain("John")
    })
  })

  describe("batchEventsForAI", () => {
    it("should batch multiple events for AI", () => {
      const events = [
        createUserAction("s1", "click", "btn-1"),
        createDataModelChange("s1", "/name", "John"),
      ]

      const batched = batchEventsForAI(events)

      expect(typeof batched).toBe("string")
      expect(batched).toContain("click")
      expect(batched).toContain("/name")
    })
  })

  describe("ActionTypes", () => {
    it("should define standard action types", () => {
      expect(ActionTypes).toBeDefined()
      expect(ActionTypes.CLICK).toBe("click")
      expect(ActionTypes.SUBMIT).toBe("submit")
      expect(ActionTypes.CANCEL).toBe("cancel")
    })
  })
})

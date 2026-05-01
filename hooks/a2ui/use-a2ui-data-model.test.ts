/**
 * Tests for useA2UIDataModel hooks
 */

import { renderHook, act } from "@testing-library/react"
import {
  useA2UIDataModel,
  useA2UIBoundValue,
  useA2UIWatchPaths,
  useA2UIFormField,
} from "./use-a2ui-data-model"

// Mock the store
const mockSetDataValue = jest.fn()
const mockEmitDataChange = jest.fn()
let mockSurfaces: Record<string, { dataModel: Record<string, unknown> }> = {}

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: jest.fn((selector) => {
    const state = {
      surfaces: mockSurfaces,
      setDataValue: mockSetDataValue,
      emitDataChange: mockEmitDataChange,
    }
    return selector(state)
  }),
}))

// Mock data-model functions
jest.mock("@/lib/a2ui/data-model", () => ({
  getValueByPath: jest.fn((dataModel, path) => {
    const parts = path.replace(/^\//, "").split("/")
    let value: unknown = dataModel
    for (const part of parts) {
      if (value && typeof value === "object") {
        value = (value as Record<string, unknown>)[part]
      } else {
        return undefined
      }
    }
    return value
  }),
  resolveStringOrPath: jest.fn((value, dataModel, defaultValue) => {
    if (typeof value === "string") return value
    if (value && typeof value === "object" && "path" in value) {
      return (dataModel[value.path.replace(/^\//, "")] as string) ?? defaultValue
    }
    return defaultValue
  }),
  resolveNumberOrPath: jest.fn((value, _dataModel, defaultValue) => {
    if (typeof value === "number") return value
    return defaultValue
  }),
  resolveBooleanOrPath: jest.fn((value, _dataModel, defaultValue) => {
    if (typeof value === "boolean") return value
    return defaultValue
  }),
  resolveArrayOrPath: jest.fn((value, _dataModel, defaultValue) => {
    if (Array.isArray(value)) return value
    return defaultValue
  }),
}))

describe("useA2UIDataModel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSurfaces = {
      "test-surface": {
        dataModel: {
          user: {
            name: "John",
            age: 30,
          },
          items: ["a", "b", "c"],
          active: true,
        },
      },
    }
  })

  describe("initialization", () => {
    it("should return data model for existing surface", () => {
      const { result } = renderHook(() => useA2UIDataModel("test-surface"))

      expect(result.current.dataModel).toEqual({
        user: { name: "John", age: 30 },
        items: ["a", "b", "c"],
        active: true,
      })
    })

    it("should return empty object for non-existent surface", () => {
      const { result } = renderHook(() => useA2UIDataModel("non-existent"))

      expect(result.current.dataModel).toEqual({})
    })
  })

  describe("getValue", () => {
    it("should get value by path", () => {
      const { result } = renderHook(() => useA2UIDataModel("test-surface"))

      const value = result.current.getValue("/user/name")

      expect(value).toBe("John")
    })

    it("should return undefined for invalid path", () => {
      const { result } = renderHook(() => useA2UIDataModel("test-surface"))

      const value = result.current.getValue("/invalid/path")

      expect(value).toBeUndefined()
    })
  })

  describe("setValue", () => {
    it("should call store setDataValue", () => {
      const { result } = renderHook(() => useA2UIDataModel("test-surface"))

      act(() => {
        result.current.setValue("/user/name", "Jane")
      })

      expect(mockSetDataValue).toHaveBeenCalledWith("test-surface", "/user/name", "Jane")
    })
  })

  describe("resolve functions", () => {
    it("should resolve string value", () => {
      const { result } = renderHook(() => useA2UIDataModel("test-surface"))

      const value = result.current.resolveString("Hello")

      expect(value).toBe("Hello")
    })

    it("should resolve number value", () => {
      const { result } = renderHook(() => useA2UIDataModel("test-surface"))

      const value = result.current.resolveNumber(42)

      expect(value).toBe(42)
    })

    it("should resolve boolean value", () => {
      const { result } = renderHook(() => useA2UIDataModel("test-surface"))

      const value = result.current.resolveBoolean(true)

      expect(value).toBe(true)
    })

    it("should resolve array value", () => {
      const { result } = renderHook(() => useA2UIDataModel("test-surface"))

      const value = result.current.resolveArray(["x", "y"])

      expect(value).toEqual(["x", "y"])
    })
  })
})

describe("useA2UIBoundValue", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSurfaces = {
      "test-surface": {
        dataModel: {
          count: 5,
          message: "Hello",
        },
      },
    }
  })

  it("should return current value and setter", () => {
    const { result } = renderHook(() => useA2UIBoundValue("test-surface", "/count", 0))

    const [value, setValue] = result.current

    expect(value).toBe(5)
    expect(typeof setValue).toBe("function")
  })

  it("should return default value when path not found", () => {
    const { result } = renderHook(() => useA2UIBoundValue("test-surface", "/nonexistent", 100))

    const [value] = result.current

    expect(value).toBe(100)
  })

  it("should update value via setter", () => {
    const { result } = renderHook(() => useA2UIBoundValue("test-surface", "/count", 0))

    act(() => {
      result.current[1](10)
    })

    expect(mockSetDataValue).toHaveBeenCalledWith("test-surface", "/count", 10)
  })
})

describe("useA2UIWatchPaths", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSurfaces = {
      "test-surface": {
        dataModel: {
          a: 1,
          b: 2,
          c: 3,
        },
      },
    }
  })

  it("should return values for all watched paths", () => {
    const { result } = renderHook(() => useA2UIWatchPaths("test-surface", ["/a", "/b"]))

    expect(result.current["/a"]).toBe(1)
    expect(result.current["/b"]).toBe(2)
  })

  it("should return empty object for non-existent surface", () => {
    const { result } = renderHook(() => useA2UIWatchPaths("non-existent", ["/a", "/b"]))

    expect(result.current).toEqual({})
  })
})

describe("useA2UIFormField", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSurfaces = {
      "test-surface": {
        dataModel: {
          username: "john_doe",
          email: "john@example.com",
        },
      },
    }
  })

  it("should return field value and handlers", () => {
    const { result } = renderHook(() => useA2UIFormField("test-surface", "/username"))

    expect(result.current.value).toBe("john_doe")
    expect(typeof result.current.onChange).toBe("function")
    expect(typeof result.current.onBlur).toBe("function")
  })

  it("should return default value when field not found", () => {
    const { result } = renderHook(() =>
      useA2UIFormField("test-surface", "/nonexistent", { defaultValue: "default" })
    )

    expect(result.current.value).toBe("default")
  })

  it("should call setDataValue on change", () => {
    const { result } = renderHook(() => useA2UIFormField("test-surface", "/username"))

    act(() => {
      result.current.onChange("new_username")
    })

    expect(mockSetDataValue).toHaveBeenCalledWith("test-surface", "/username", "new_username")
  })

  it("should apply transform on change", () => {
    const transform = jest.fn((value: string) => value.toUpperCase())
    const { result } = renderHook(() =>
      useA2UIFormField("test-surface", "/username", { transform })
    )

    act(() => {
      result.current.onChange("hello")
    })

    expect(transform).toHaveBeenCalledWith("hello")
    expect(mockSetDataValue).toHaveBeenCalledWith("test-surface", "/username", "HELLO")
  })

  it("should emit data change on blur", () => {
    const { result } = renderHook(() => useA2UIFormField("test-surface", "/username"))

    act(() => {
      result.current.onBlur()
    })

    expect(mockEmitDataChange).toHaveBeenCalledWith("test-surface", "/username", "john_doe")
  })
})

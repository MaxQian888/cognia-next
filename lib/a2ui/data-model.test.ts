/**
 * A2UI Data Model Tests
 */

import {
  parseJsonPointer,
  getValueByPath,
  setValueByPath,
  deleteValueByPath,
  deepClone,
  deepMerge,
  resolveStringOrPath,
  resolveNumberOrPath,
  resolveBooleanOrPath,
  resolveArrayOrPath,
  getBindingPath,
  collectComponentDataPaths,
} from "./data-model"

describe("A2UI Data Model", () => {
  describe("parseJsonPointer", () => {
    it("should parse empty pointer", () => {
      expect(parseJsonPointer("")).toEqual([])
    })

    it("should parse simple path", () => {
      expect(parseJsonPointer("/name")).toEqual(["name"])
    })

    it("should parse nested path", () => {
      expect(parseJsonPointer("/user/name")).toEqual(["user", "name"])
    })

    it("should handle array indices", () => {
      expect(parseJsonPointer("/items/0/name")).toEqual(["items", "0", "name"])
    })

    it("should handle escaped characters", () => {
      expect(parseJsonPointer("/a~1b")).toEqual(["a/b"])
      expect(parseJsonPointer("/a~0b")).toEqual(["a~b"])
    })
  })

  describe("getValueByPath", () => {
    const data = {
      name: "John",
      age: 30,
      address: {
        city: "New York",
        zip: "10001",
      },
      items: ["a", "b", "c"],
    }

    it("should get root value", () => {
      expect(getValueByPath(data, "")).toEqual(data)
    })

    it("should get simple property", () => {
      expect(getValueByPath(data, "/name")).toBe("John")
      expect(getValueByPath(data, "/age")).toBe(30)
    })

    it("should get nested property", () => {
      expect(getValueByPath(data, "/address/city")).toBe("New York")
    })

    it("should get array element", () => {
      expect(getValueByPath(data, "/items/0")).toBe("a")
      expect(getValueByPath(data, "/items/2")).toBe("c")
    })

    it("should return undefined for non-existent path", () => {
      expect(getValueByPath(data, "/nonexistent")).toBeUndefined()
      expect(getValueByPath(data, "/address/country")).toBeUndefined()
    })
  })

  describe("setValueByPath", () => {
    it("should set simple property", () => {
      const data = { name: "John" }
      const result = setValueByPath(data, "/name", "Jane")
      expect(result.name).toBe("Jane")
    })

    it("should create nested path", () => {
      const data = {}
      const result = setValueByPath(data, "/user/name", "John")
      expect(result).toEqual({ user: { name: "John" } })
    })

    it("should set array element", () => {
      const data = { items: ["a", "b", "c"] }
      const result = setValueByPath(data, "/items/1", "x")
      expect(result.items).toEqual(["a", "x", "c"])
    })

    it("should not mutate original object", () => {
      const data = { name: "John" }
      const result = setValueByPath(data, "/name", "Jane")
      expect(data.name).toBe("John")
      expect(result.name).toBe("Jane")
    })
  })

  describe("deleteValueByPath", () => {
    it("should delete simple property", () => {
      const data = { name: "John", age: 30 }
      const result = deleteValueByPath(data, "/age")
      expect(result).toEqual({ name: "John" })
    })

    it("should delete nested property", () => {
      const data = { user: { name: "John", age: 30 } }
      const result = deleteValueByPath(data, "/user/age")
      expect(result).toEqual({ user: { name: "John" } })
    })

    it("should not mutate original object", () => {
      const data = { name: "John", age: 30 }
      deleteValueByPath(data, "/age")
      expect(data).toEqual({ name: "John", age: 30 })
    })
  })

  describe("deepClone", () => {
    it("should clone primitive values", () => {
      expect(deepClone(42)).toBe(42)
      expect(deepClone("hello")).toBe("hello")
      expect(deepClone(null)).toBe(null)
    })

    it("should clone objects", () => {
      const obj = { a: 1, b: { c: 2 } }
      const clone = deepClone(obj)
      expect(clone).toEqual(obj)
      expect(clone).not.toBe(obj)
      expect(clone.b).not.toBe(obj.b)
    })

    it("should clone arrays", () => {
      const arr = [1, [2, 3], { a: 4 }]
      const clone = deepClone(arr)
      expect(clone).toEqual(arr)
      expect(clone).not.toBe(arr)
      expect(clone[1]).not.toBe(arr[1])
    })
  })

  describe("deepMerge", () => {
    it("should merge simple objects", () => {
      const target = { a: 1, b: 2 }
      const source = { b: 3, c: 4 }
      expect(deepMerge(target, source)).toEqual({ a: 1, b: 3, c: 4 })
    })

    it("should merge nested objects", () => {
      const target = { user: { name: "John", age: 30 } }
      const source = { user: { age: 31, city: "NYC" } }
      expect(deepMerge(target, source)).toEqual({
        user: { name: "John", age: 31, city: "NYC" },
      })
    })

    it("should not mutate original objects", () => {
      const target = { a: 1 }
      const source = { b: 2 }
      deepMerge(target, source)
      expect(target).toEqual({ a: 1 })
    })
  })

  describe("resolveStringOrPath", () => {
    const dataModel = { name: "John", nested: { value: "test" } }

    it("should return string value directly", () => {
      expect(resolveStringOrPath("Hello", dataModel)).toBe("Hello")
    })

    it("should resolve path value", () => {
      expect(resolveStringOrPath({ path: "/name" }, dataModel)).toBe("John")
    })

    it("should return default for non-existent path", () => {
      expect(resolveStringOrPath({ path: "/nonexistent" }, dataModel, "default")).toBe("default")
    })
  })

  describe("resolveNumberOrPath", () => {
    const dataModel = { count: 42, nested: { value: 10 } }

    it("should return number value directly", () => {
      expect(resolveNumberOrPath(100, dataModel)).toBe(100)
    })

    it("should resolve path value", () => {
      expect(resolveNumberOrPath({ path: "/count" }, dataModel)).toBe(42)
    })

    it("should return default for non-existent path", () => {
      expect(resolveNumberOrPath({ path: "/nonexistent" }, dataModel, 0)).toBe(0)
    })
  })

  describe("resolveBooleanOrPath", () => {
    const dataModel = { active: true, nested: { enabled: false } }

    it("should return boolean value directly", () => {
      expect(resolveBooleanOrPath(true, dataModel)).toBe(true)
    })

    it("should resolve path value", () => {
      expect(resolveBooleanOrPath({ path: "/active" }, dataModel)).toBe(true)
    })

    it("should return default for non-existent path", () => {
      expect(resolveBooleanOrPath({ path: "/nonexistent" }, dataModel, false)).toBe(false)
    })
  })

  describe("resolveArrayOrPath", () => {
    const dataModel = { items: [1, 2, 3], nested: { list: ["a", "b"] } }

    it("should return array value directly", () => {
      expect(resolveArrayOrPath([4, 5], dataModel)).toEqual([4, 5])
    })

    it("should resolve path value", () => {
      expect(resolveArrayOrPath({ path: "/items" }, dataModel)).toEqual([1, 2, 3])
    })

    it("should return default for non-existent path", () => {
      expect(resolveArrayOrPath({ path: "/nonexistent" }, dataModel, [])).toEqual([])
    })
  })

  describe("getBindingPath", () => {
    it("should return path from path object", () => {
      expect(getBindingPath({ path: "/name" })).toBe("/name")
    })

    it("should return null for non-path value", () => {
      expect(getBindingPath("Hello")).toBeNull()
      expect(getBindingPath(42)).toBeNull()
      expect(getBindingPath(null)).toBeNull()
    })
  })

  describe("structural sharing", () => {
    describe("setValueByPath", () => {
      it("shares untouched sibling subtrees by reference", () => {
        const model = {
          form: { name: "Ann", age: 30 },
          settings: { theme: "dark", nested: { a: 1 } },
        }
        const next = setValueByPath(model, "/form/name", "Bob")

        // The mutated value is updated...
        expect(getValueByPath(next, "/form/name")).toBe("Bob")
        // ...but the sibling subtree keeps its identity.
        expect(next.settings).toBe(model.settings)
        expect((next.settings as { nested: unknown }).nested).toBe(model.settings.nested)
        // The original is never mutated.
        expect(model.form.name).toBe("Ann")
      })

      it("copies only the spine to the mutated node", () => {
        const model = { a: { b: { c: 1 } }, other: { x: 1 } }
        const next = setValueByPath(model, "/a/b/c", 2)

        expect(next).not.toBe(model)
        expect(next.a).not.toBe(model.a)
        expect((next.a as { b: unknown }).b).not.toBe(model.a.b)
        expect(next.other).toBe(model.other) // untouched branch shared
      })

      it("returns the same object when setting an Object.is-equal value", () => {
        const shared = { id: 1 }
        const model = { item: shared, list: [1, 2] }
        const next = setValueByPath(model, "/item", shared)
        expect(next).toBe(model)
      })

      it("shares untouched array elements when updating one index", () => {
        const a = { v: 1 }
        const b = { v: 2 }
        const model = { rows: [a, b] }
        const next = setValueByPath(model, "/rows/1/v", 99)

        expect(getValueByPath(next, "/rows/1/v")).toBe(99)
        expect((next.rows as unknown[])[0]).toBe(a) // sibling element shared
        expect(model.rows[1].v).toBe(2) // original untouched
      })

      it("creates intermediate containers for missing paths", () => {
        const model: Record<string, unknown> = {}
        const next = setValueByPath(model, "/a/0/b", "x")
        expect(getValueByPath(next, "/a/0/b")).toBe("x")
        expect(Array.isArray((next.a as Record<string, unknown>) ? next.a : null)).toBe(true)
      })
    })

    describe("deleteValueByPath", () => {
      it("shares untouched siblings and preserves the original", () => {
        const model = { a: { keep: 1, drop: 2 }, other: { x: 1 } }
        const next = deleteValueByPath(model, "/a/drop")

        expect(getValueByPath(next, "/a/drop")).toBeUndefined()
        expect(getValueByPath(next, "/a/keep")).toBe(1)
        expect(next.other).toBe(model.other)
        expect(model.a.drop).toBe(2)
      })

      it("returns the same object when the path does not exist", () => {
        const model = { a: { b: 1 } }
        expect(deleteValueByPath(model, "/a/missing")).toBe(model)
        expect(deleteValueByPath(model, "/x/y/z")).toBe(model)
      })
    })

    describe("deepMerge", () => {
      it("keeps untouched branches by reference", () => {
        const target = { a: { x: 1 }, b: { y: 2 } }
        const merged = deepMerge(target, { a: { x: 9 } })

        expect(merged.a).toEqual({ x: 9 })
        expect(merged.b).toBe(target.b) // untouched branch shared
      })

      it("returns the original target when the source changes nothing", () => {
        const target = { a: { x: 1 }, b: 2 }
        expect(deepMerge(target, { a: { x: 1 }, b: 2 })).toBe(target)
        expect(deepMerge(target, {})).toBe(target)
      })
    })
  })

  describe("collectComponentDataPaths", () => {
    it("collects {path} PathValue references", () => {
      const component = {
        component: "Text",
        text: { path: "/user/name" },
        visible: { path: "/flags/show" },
      }
      const paths = collectComponentDataPaths(component)
      expect(paths).toEqual(expect.arrayContaining(["/user/name", "/flags/show"]))
    })

    it("collects plain-string pointer fields invisible to extractReferencedPaths", () => {
      const list = {
        component: "List",
        template: { itemId: "tpl", dataPath: "/rows" },
      }
      expect(collectComponentDataPaths(list)).toContain("/rows")

      const table = {
        component: "Table",
        data: { path: "/data/rows" },
        sortKeyPath: "/ui/sortKey",
        sortDirectionPath: "/ui/sortDir",
      }
      const tablePaths = collectComponentDataPaths(table)
      expect(tablePaths).toEqual(
        expect.arrayContaining(["/data/rows", "/ui/sortKey", "/ui/sortDir"])
      )
    })

    it("returns an empty list for a static component with no bindings", () => {
      expect(collectComponentDataPaths({ component: "Divider" })).toEqual([])
    })

    it("de-duplicates repeated paths", () => {
      const component = {
        component: "Row",
        a: { path: "/x" },
        b: { path: "/x" },
      }
      expect(collectComponentDataPaths(component)).toEqual(["/x"])
    })
  })
})

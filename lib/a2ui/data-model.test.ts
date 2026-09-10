/**
 * A2UI Data Model Tests
 */

import {
  parseJsonPointer,
  resolveComputedFields,
  isPathValue,
  createRelativePathResolver,
  watchPaths,
  computedHelpers,
  createJsonPointer,
  extractReferencedPaths,
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
  isA2UIDataModel,
  isSafeDataModelKey,
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

    it("rejects malformed escape sequences", () => {
      expect(() => parseJsonPointer("/a~2b")).toThrow(/invalid json pointer/i)
      expect(() => parseJsonPointer("/trailing~")).toThrow(/invalid json pointer/i)
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

    it("does not traverse inherited properties or malformed array indices", () => {
      expect(getValueByPath({}, "/toString")).toBeUndefined()
      expect(getValueByPath({ items: ["a", "b"] }, "/items/1x")).toBeUndefined()
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

    it("rejects unsafe object segments and malformed array indices", () => {
      const data = { items: ["a", "b"] }
      expect(setValueByPath(data, "/__proto__/polluted", true)).toBe(data)
      expect(setValueByPath(data, "/constructor/prototype/polluted", true)).toBe(data)
      expect(setValueByPath(data, "/items/1x", "x")).toBe(data)
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
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

    it("rejects unsafe object segments and malformed array indices", () => {
      const data = { items: ["a", "b"] }
      expect(deleteValueByPath(data, "/__proto__/polluted")).toBe(data)
      expect(deleteValueByPath(data, "/items/1x")).toBe(data)
    })
  })

  describe("data-model validation", () => {
    it("accepts only safe, finite, acyclic JSON object models", () => {
      expect(isA2UIDataModel({ text: "ok", count: 1, nested: [true, null] })).toBe(true)
      expect(isA2UIDataModel([])).toBe(false)
      expect(isA2UIDataModel({ count: Number.NaN })).toBe(false)
      expect(isA2UIDataModel({ fn: () => undefined })).toBe(false)

      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      expect(isA2UIDataModel(cyclic)).toBe(false)
    })

    it("rejects keys that cannot be represented safely by the editor pointer contract", () => {
      expect(isSafeDataModelKey("profile/name")).toBe(true)
      expect(isSafeDataModelKey("~state")).toBe(true)
      expect(isSafeDataModelKey("")).toBe(false)
      expect(isSafeDataModelKey("__proto__")).toBe(false)
      expect(isSafeDataModelKey("constructor")).toBe(false)
      expect(isSafeDataModelKey("prototype")).toBe(false)
      expect(isA2UIDataModel(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(false)
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

describe("data model boundary regressions", () => {
  it("uses decoded JSON Pointer keys for computed fields and rejects unsafe destinations", () => {
    const model = { count: 2 }
    const result = resolveComputedFields(model, {
      "/a~1b": { deps: ["/count"], compute: (value) => Number(value) + 1 },
      "/~0count": { deps: ["/a~1b"], compute: (value) => value },
      "/__proto__": { deps: [], compute: () => ({ injected: true }) },
      "/constructor": { deps: [], compute: () => "unsafe" },
      invalid: { deps: [], compute: () => "invalid" },
    })
    expect(result).toEqual({ count: 2, "a/b": 3, "~count": 3 })
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(model).toEqual({ count: 2 })
  })

  it("keeps clone and merged model prototypes unchanged for unsafe incoming keys", () => {
    const source = JSON.parse(
      '{"__proto__":{"injected":true},"constructor":{"prototype":{"x":1}},"nested":{"prototype":1,"safe":2}}'
    )
    for (const result of [deepClone(source), deepMerge({}, source)]) {
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
      expect(result).toEqual({ nested: { safe: 2 } })
      expect(isA2UIDataModel(result)).toBe(true)
    }
  })

  it("creates object keys for noncanonical numeric tokens instead of unreadable array properties", () => {
    expect(setValueByPath({}, "/codes/01/name", "one")).toEqual({
      codes: { "01": { name: "one" } },
    })
    expect(setValueByPath({}, "/rows/0/01/name", "one")).toEqual({
      rows: [{ "01": { name: "one" } }],
    })
  })

  it("rejects empty nested keys consistently with reads and model validation", () => {
    const model = { keep: 1 }
    expect(setValueByPath(model, "/nested//name", "hidden")).toBe(model)
    expect(deleteValueByPath(model, "/nested//name")).toBe(model)
  })

  it("does not recognize non-string or inherited paths as bindings", () => {
    for (const value of [{ path: 0 }, { path: null }, Object.create({ path: "/count" })]) {
      expect(isPathValue(value)).toBe(false)
      expect(getBindingPath(value)).toBeNull()
    }
  })

  it("resolves an empty relative path to the current list item", () => {
    const model = { rows: [{ name: "Alice" }] }
    expect(createRelativePathResolver("/rows", 0)("", model)).toBe(model.rows[0])
  })
})

describe("data model helpers and subscriptions", () => {
  it("round-trips escaped keys while retaining the established root alias", () => {
    expect(createJsonPointer(["a/b", "~key"])).toBe("/a~1b/~0key")
    expect(parseJsonPointer(createJsonPointer(["a/b", "~key"]))).toEqual(["a/b", "~key"])
    expect(createJsonPointer([])).toBe("/")
    expect(parseJsonPointer("/")).toEqual([])
    expect(() => parseJsonPointer("invalid")).toThrow()
    expect(getValueByPath({}, "invalid")).toBeUndefined()
  })

  it("replaces and deletes root models, preserving invalid replacement identity", () => {
    const original = { a: 1 }
    const replacement = { b: 2 }
    expect(setValueByPath(original, "/", replacement)).toBe(replacement)
    expect(setValueByPath(original, "", replacement)).toBe(replacement)
    expect(setValueByPath(original, "/", [])).toBe(original)
    expect(setValueByPath(original, "/", null)).toBe(original)
    expect(deleteValueByPath(original, "/")).toEqual({})
    expect(getValueByPath({ a: null }, "/a/name")).toBeUndefined()
    expect(getValueByPath({ a: 1 }, "/a/name")).toBeUndefined()
  })

  it("deletes array elements and nested fields without changing untouched references", () => {
    const model = { rows: [{ keep: 1, drop: 2 }, { keep: 3 }], spare: { value: true } }
    const removed = deleteValueByPath(model, "/rows/0")
    expect(removed.rows).toEqual([{ keep: 3 }])
    expect(removed.spare).toBe(model.spare)
    const updated = deleteValueByPath(model, "/rows/0/drop")
    expect(updated.rows).toEqual([{ keep: 1 }, { keep: 3 }])
    expect((updated.rows as unknown[])[1]).toBe(model.rows[1])
    expect(deleteValueByPath(model, "/rows/0/absent")).toBe(model)
    expect(deleteValueByPath(model, "/rows/9")).toBe(model)
    expect(setValueByPath(model, "/rows/1", model.rows[1])).toBe(model)
    expect(setValueByPath(model, "/rows/1/keep", 3)).toBe(model)
  })

  it("notifies only changed bound values, including nested arrays and type changes", () => {
    const onChange = jest.fn()
    const watch = (oldValue: unknown, newValue: unknown) =>
      watchPaths([{ path: "/value", callback: onChange }], { value: oldValue }, { value: newValue })
    watch({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })
    watch(null, null)
    expect(onChange).not.toHaveBeenCalled()
    for (const [before, after] of [
      [null, {}],
      [1, "1"],
      [[1], [1, 2]],
      [[1], [2]],
      [{ a: 1 }, { a: 2 }],
      [{ a: 1 }, { a: 1, b: 2 }],
      [[], {}],
    ]) {
      watch(before, after)
      expect(onChange).toHaveBeenLastCalledWith(after, before)
    }
    expect(onChange).toHaveBeenCalledTimes(7)
  })

  it("resolves derived totals, counts, formatting and nested fields without mutating inputs", () => {
    const model = { amount: 12.5, other: 7.5, rows: [1, 2, 3], name: "Ada", title: "Dr" }
    const derived = resolveComputedFields(model, {
      "/total": computedHelpers.sum("/amount", "/other", "/missing"),
      "/count": computedHelpers.count("/rows"),
      "/selected": computedHelpers.countWhere("/rows", (value) => Number(value) > 1),
      "/formatted": computedHelpers.currency("/total"),
      "/custom": computedHelpers.currency("/amount", "€", 1),
      "/label": computedHelpers.concat(" ", "/title", "/name", "/missing"),
      "/stats/percent": computedHelpers.percentage("/selected", "/count"),
      "/failed": {
        deps: [],
        compute: () => {
          throw new Error("failed")
        },
      },
      "/afterFailure": { deps: ["/total"], compute: (value) => value },
    })
    expect(derived).toMatchObject({
      total: 20,
      count: 3,
      selected: 2,
      formatted: "$20.00",
      custom: "€12.5",
      label: "Dr Ada",
      stats: { percent: 67 },
      afterFailure: 20,
    })
    expect(derived).not.toHaveProperty("failed")
    expect(model).not.toHaveProperty("total")
    expect(derived.rows).toBe(model.rows)
    expect(computedHelpers.count("/missing").compute(undefined)).toBe(0)
    expect(computedHelpers.countWhere("/missing", () => true).compute(null)).toBe(0)
    expect(computedHelpers.currency("/missing").compute(undefined)).toBe("$0.00")
    expect(computedHelpers.percentage("/a", "/b").compute(undefined, 0)).toBe(0)
  })

  it("uses resolver defaults for malformed bindings instead of treating them as root references", () => {
    const invalid = { path: 0 } as unknown as { path: string }
    expect(resolveStringOrPath(invalid, { name: "Ada" }, "missing")).toBe("missing")
    expect(resolveNumberOrPath(invalid, {}, 5)).toBe(5)
    expect(resolveBooleanOrPath(invalid, {}, true)).toBe(true)
    expect(resolveArrayOrPath(invalid, {}, [1])).toEqual([1])
    const resolver = createRelativePathResolver("/rows", 0)
    const model = { name: "global", rows: [{ name: "local" }] }
    expect(resolver("/name", model)).toBe("global")
    expect(resolver("name", model)).toBe("local")
  })

  it("finds nested list bindings and pointer fields without treating numeric paths as references", () => {
    const component = {
      children: [{ value: { path: "/value" }, currentStepPath: "/step" }],
      invalid: { path: 3 },
      dataPath: "",
    }
    expect(extractReferencedPaths([component])).toEqual(["/value"])
    expect(collectComponentDataPaths(component)).toEqual(["/value", "/step"])
  })
})

import {
  DEFAULT_MAX_REALTIME_TOOLS,
  mapRealtimeTools,
  normalizeToolSchema,
  type PluginToolEntry,
} from "./tools"

const mockHasNoLeakingPiiDeep = jest.fn<boolean, [unknown]>(() => true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (value: unknown) => mockHasNoLeakingPiiDeep(value),
}))

beforeEach(() => {
  mockHasNoLeakingPiiDeep.mockReset().mockReturnValue(true)
})

function entry(overrides: Partial<PluginToolEntry> = {}): PluginToolEntry {
  return {
    name: "search_notes",
    description: "Search the user's notes",
    jsonSchema: { type: "object", properties: { q: { type: "string" } } },
    pluginId: "notes",
    ...overrides,
  }
}

describe("normalizeToolSchema", () => {
  it("passes a schema that already declares a type through untouched", () => {
    // Plugins own their contracts — rewriting one would change what the plugin
    // validates on the way in.
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
    expect(normalizeToolSchema(schema)).toBe(schema)
  })

  it("labels a typeless schema that has properties as an object", () => {
    expect(normalizeToolSchema({ properties: { q: { type: "string" } } })).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    })
  })

  it("replaces a bare {} with a real object schema", () => {
    // A bare {} is legal JSON Schema but vendors reject it, and rejection takes
    // down the whole session.update rather than just this tool.
    expect(normalizeToolSchema({})).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    })
  })

  it("refuses extra arguments on a no-parameter tool", () => {
    // Without additionalProperties:false some models invent arguments the
    // plugin never declared and therefore never validates.
    expect(normalizeToolSchema({})).toMatchObject({ additionalProperties: false })
  })

  it("falls back for a non-object schema", () => {
    expect(normalizeToolSchema([] as unknown as object)).toMatchObject({ type: "object" })
  })
})

describe("mapRealtimeTools", () => {
  it("returns nothing for an absent manifest", () => {
    expect(mapRealtimeTools(undefined)).toEqual({ tools: [], dropped: [] })
  })

  it("maps an entry to the vendor function shape", () => {
    const { tools } = mapRealtimeTools([entry()])

    expect(tools).toEqual([
      {
        type: "function",
        name: "search_notes",
        description: "Search the user's notes",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    ])
  })

  it("omits description rather than sending an empty one", () => {
    const { tools } = mapRealtimeTools([entry({ description: "" })])
    expect(tools[0]).not.toHaveProperty("description")
  })

  it("drops a name the vendors will not accept", () => {
    // Namespaced plugin tools routinely exceed the pattern.
    const { tools, dropped } = mapRealtimeTools([entry({ name: "notes:search notes" })])

    expect(tools).toHaveLength(0)
    expect(dropped).toEqual([
      { name: "notes:search notes", pluginId: "notes", reason: "invalid-name" },
    ])
  })

  it("drops rather than truncates an over-long name", () => {
    // Truncating to 64 chars would collide two distinct tools onto one name.
    const { dropped } = mapRealtimeTools([entry({ name: "a".repeat(65) })])
    expect(dropped[0].reason).toBe("invalid-name")
  })

  it("accepts a name at exactly the length limit", () => {
    const { tools } = mapRealtimeTools([entry({ name: "a".repeat(64) })])
    expect(tools).toHaveLength(1)
  })

  it("drops an entry with no usable name", () => {
    const { dropped } = mapRealtimeTools([entry({ name: undefined as unknown as string })])
    expect(dropped[0]).toMatchObject({ reason: "invalid-name" })
  })

  it("reports an unknown pluginId instead of crashing on a malformed entry", () => {
    const { dropped } = mapRealtimeTools([
      { name: "!", description: "", jsonSchema: {}, pluginId: undefined as unknown as string },
    ])
    expect(dropped[0].pluginId).toBe("unknown")
  })

  it("keeps the first of two entries sharing a name", () => {
    // resolveSendOptions appends from ~8 sources and the promoted built-ins go
    // first, so first-wins is what makes them supersede the plugin duplicate.
    const { tools, dropped } = mapRealtimeTools([
      entry({ description: "promoted built-in", pluginId: "builtin" }),
      entry({ description: "plugin duplicate", pluginId: "web-tools" }),
    ])

    expect(tools).toHaveLength(1)
    expect(tools[0].description).toBe("promoted built-in")
    expect(dropped).toEqual([{ name: "search_notes", pluginId: "web-tools", reason: "duplicate" }])
  })

  it("drops an entry whose description is not a string", () => {
    const { dropped } = mapRealtimeTools([
      entry({ description: { text: "hi" } as unknown as string }),
    ])
    expect(dropped[0].reason).toBe("invalid-description")
  })

  it("drops local manifest text that fails the PII gate", () => {
    mockHasNoLeakingPiiDeep.mockReturnValueOnce(false)

    const { tools, dropped } = mapRealtimeTools([
      entry({ description: "Contact alice@example.com" }),
    ])

    expect(tools).toHaveLength(0)
    expect(dropped).toEqual([{ name: "search_notes", pluginId: "notes", reason: "pii" }])
  })

  it("caps the number of advertised tools", () => {
    const entries = Array.from({ length: DEFAULT_MAX_REALTIME_TOOLS + 3 }, (_, i) =>
      entry({ name: `tool_${i}` })
    )

    const { tools, dropped } = mapRealtimeTools(entries)

    expect(tools).toHaveLength(DEFAULT_MAX_REALTIME_TOOLS)
    expect(dropped).toHaveLength(3)
    expect(dropped.every((item) => item.reason === "tool-budget")).toBe(true)
  })

  it("preserves manifest order so truncation drops the lowest-priority tools", () => {
    const { tools } = mapRealtimeTools(
      [entry({ name: "zzz_last" }), entry({ name: "aaa_first" })],
      { maxTools: 1 }
    )

    // Alphabetical sorting would have kept the wrong one.
    expect(tools.map((tool) => tool.name)).toEqual(["zzz_last"])
  })

  it("caps the serialized size of the tool block", () => {
    const fat = entry({ name: "fat_tool", description: "x".repeat(500) })

    const { tools, dropped } = mapRealtimeTools([fat], { maxBytes: 100 })

    expect(tools).toHaveLength(0)
    expect(dropped[0].reason).toBe("byte-budget")
  })

  it("still admits a small tool queued behind an oversized one", () => {
    // One huge schema must not shut out everything after it.
    const { tools } = mapRealtimeTools(
      [entry({ name: "fat_tool", description: "x".repeat(500) }), entry({ name: "thin_tool" })],
      { maxBytes: 200 }
    )

    expect(tools.map((tool) => tool.name)).toEqual(["thin_tool"])
  })

  it("normalizes each entry's schema on the way through", () => {
    const { tools } = mapRealtimeTools([entry({ jsonSchema: {} })])
    expect(tools[0].parameters).toMatchObject({ type: "object", additionalProperties: false })
  })
})

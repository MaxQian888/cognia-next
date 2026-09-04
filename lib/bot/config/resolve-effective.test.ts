import { defaultsFromConfigSchema, resolveBotConfig } from "./resolve-effective"

describe("defaultsFromConfigSchema", () => {
  it("is empty without a schema", () => {
    expect(defaultsFromConfigSchema(undefined)).toEqual({})
    expect(defaultsFromConfigSchema({})).toEqual({})
  })

  it("reads top-level property defaults", () => {
    expect(
      defaultsFromConfigSchema({
        type: "object",
        properties: { channel: { type: "string", default: "#ops" }, limit: { type: "number" } },
      })
    ).toEqual({ channel: "#ops" })
  })

  it("keeps a default that is explicitly null or false", () => {
    // `in` rather than truthiness: `false` and `null` are answers, and dropping
    // them would silently fall through to the next layer.
    expect(
      defaultsFromConfigSchema({
        properties: { quiet: { default: false }, owner: { default: null } },
      })
    ).toEqual({ quiet: false, owner: null })
  })

  it("ignores nested defaults rather than guessing their precedence", () => {
    expect(
      defaultsFromConfigSchema({
        properties: { nested: { type: "object", properties: { a: { default: 1 } } } },
      })
    ).toEqual({})
  })
})

describe("resolveBotConfig", () => {
  it("is empty when no layer supplies anything", () => {
    expect(resolveBotConfig({})).toEqual({ values: {}, detail: {} })
  })

  it("takes the nearest layer that has a value", () => {
    const resolved = resolveBotConfig({
      runRequest: { channel: "#incident" },
      installation: { channel: "#ops", limit: 10 },
      repository: { channel: "#repo", limit: 5, label: "bug" },
      definitionDefaults: { channel: "#default", limit: 1, label: "none", extra: true },
    })

    expect(resolved.values).toEqual({
      channel: "#incident",
      limit: 10,
      label: "bug",
      extra: true,
    })
    expect(resolved.detail.channel.source).toBe("run-request")
    expect(resolved.detail.limit.source).toBe("installation")
    expect(resolved.detail.label.source).toBe("repository")
    expect(resolved.detail.extra.source).toBe("definition-default")
  })

  it("keeps what the run asked for even when a nearer layer did not win", () => {
    const resolved = resolveBotConfig({
      installation: { channel: "#ops" },
    })
    expect(resolved.detail.channel.requested).toBeUndefined()
    expect(resolved.detail.channel.effective).toBe("#ops")
  })

  it("reports the request as requested when the request won", () => {
    const resolved = resolveBotConfig({
      runRequest: { channel: "#incident" },
      installation: { channel: "#ops" },
    })
    expect(resolved.detail.channel.requested).toBe("#incident")
    expect(resolved.detail.channel.effective).toBe("#incident")
  })

  it("treats an explicit undefined as no opinion, so the next layer wins", () => {
    const resolved = resolveBotConfig({
      runRequest: { channel: undefined },
      installation: { channel: "#ops" },
    })
    expect(resolved.values.channel).toBe("#ops")
    expect(resolved.detail.channel.source).toBe("installation")
  })

  it("lets a layer clear a value with null", () => {
    // Without this there is no way to unset something an outer layer supplied.
    const resolved = resolveBotConfig({
      installation: { channel: null },
      definitionDefaults: { channel: "#default" },
    })
    expect(resolved.values.channel).toBeNull()
    expect(resolved.detail.channel.source).toBe("installation")
  })

  it("keeps a false value rather than falling through", () => {
    const resolved = resolveBotConfig({
      installation: { quiet: false },
      definitionDefaults: { quiet: true },
    })
    expect(resolved.values.quiet).toBe(false)
    expect(resolved.detail.quiet.source).toBe("installation")
  })

  it("reports unset for a key every layer left undefined", () => {
    const resolved = resolveBotConfig({ installation: { channel: undefined } })
    expect(resolved.detail.channel.source).toBe("unset")
    expect(resolved.values.channel).toBeUndefined()
  })
})

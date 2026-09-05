import { findCommand } from "./catalog"
import { buildRequestBody, parseDataFlag, requestTemplate } from "./validate"
import type { ApiCommandEntry } from "./types"

function entry(overrides: Partial<ApiCommandEntry> = {}): ApiCommandEntry {
  return {
    name: "demo_command",
    group: "demo",
    action: "command",
    target: "execution",
    capability: "client.write",
    risk: "low",
    approval: "none",
    idempotency: "required",
    wires: ["internal"],
    bodyKind: "fields",
    flags: [
      { name: "id", flag: "id", type: "string", required: true },
      { name: "count", flag: "count", type: "integer" },
      { name: "ratio", flag: "ratio", type: "number" },
      { name: "muted", flag: "muted", type: "boolean" },
      { name: "options", flag: "options", type: "json" },
      { name: "mode", flag: "mode", type: "string", enum: ["auto", "manual"] },
      { name: "clearable", flag: "clearable", type: "string", nullable: true },
    ],
    ...overrides,
  }
}

describe("parseDataFlag", () => {
  it("parses inline JSON", () => {
    expect(parseDataFlag('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
  })

  it("reads a file behind @", () => {
    expect(parseDataFlag("@body.json", { readFile: () => '{"a":2}' })).toEqual({
      ok: true,
      value: { a: 2 },
    })
  })

  it("reads stdin behind -", () => {
    expect(parseDataFlag("-", { readStdin: () => '{"a":3}' })).toEqual({
      ok: true,
      value: { a: 3 },
    })
  })

  it("refuses unreadable JSON with a fix rather than a stack trace", () => {
    const result = parseDataFlag("{oops")
    expect(result).toMatchObject({ ok: false, error: "--data is not valid JSON" })
    expect((result as { fix: string[] }).fix[0]).toContain("JSON object")
  })

  it("names the file it could not read", () => {
    const result = parseDataFlag("@missing.json", {
      readFile: () => {
        throw new Error("ENOENT")
      },
    })
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain("@missing.json")
  })
})

describe("buildRequestBody", () => {
  it("coerces each flag to the type the schema declares", () => {
    const result = buildRequestBody({
      entry: entry(),
      flags: {
        id: "abc",
        count: "3",
        ratio: "1.5",
        muted: true,
        options: '{"x":1}',
        mode: "manual",
      },
    })
    expect(result).toEqual({
      ok: true,
      body: { id: "abc", count: 3, ratio: 1.5, muted: true, options: { x: 1 }, mode: "manual" },
    })
  })

  it("sends the wire property name, not the flag spelling", () => {
    const command = entry({
      flags: [{ name: "defaultMode", flag: "default-mode", type: "string" }],
    })
    const result = buildRequestBody({ entry: command, flags: { "default-mode": "auto" } })
    expect(result).toEqual({ ok: true, body: { defaultMode: "auto" } })
  })

  it("lets a flag override the same field from --data", () => {
    const result = buildRequestBody({ entry: entry(), flags: { id: "flag" }, data: { id: "data" } })
    expect(result).toMatchObject({ ok: true, body: { id: "flag" } })
  })

  it("keeps fields that only --data supplies", () => {
    const result = buildRequestBody({ entry: entry(), flags: {}, data: { id: "x", count: 9 } })
    expect(result).toMatchObject({ ok: true, body: { id: "x", count: 9 } })
  })

  it("refuses an unknown flag locally, because the host answers 422 for one", () => {
    const result = buildRequestBody({ entry: entry(), flags: { id: "x", nope: "1" } })
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain("--nope")
    expect((result as { fix: string[] }).fix.join(" ")).toContain("rejects unknown fields")
  })

  it("suggests the nearest field for a near miss", () => {
    const result = buildRequestBody({ entry: entry(), flags: { id: "x", coun: "1" } })
    expect((result as { details: string[] }).details.join(" ")).toContain("--count")
  })

  it("ignores the CLI's own global flags", () => {
    const result = buildRequestBody({
      entry: entry(),
      flags: { id: "x", format: "json", debug: true, output: "./out", wait: true },
    })
    expect(result).toEqual({ ok: true, body: { id: "x" } })
  })

  it("names the missing required field and how to pass it", () => {
    const result = buildRequestBody({ entry: entry(), flags: { count: "1" } })
    expect((result as { error: string }).error).toContain("missing id")
    expect((result as { fix: string[] }).fix[0]).toBe("pass --id <string>")
  })

  it("tells the caller to use --data for a required field with no flag", () => {
    const command = entry({
      flags: [{ name: "sessionId", flag: "", type: "string", required: true }],
    })
    const result = buildRequestBody({ entry: command, flags: {} })
    expect((result as { fix: string[] }).fix[0]).toContain('include "sessionId" in --data')
  })

  it("refuses a value outside an enum and lists the allowed ones", () => {
    const result = buildRequestBody({ entry: entry(), flags: { id: "x", mode: "sideways" } })
    expect((result as { error: string }).error).toContain("sideways")
    expect(result as { details: string[] }).toBeTruthy()
  })

  it("checks an enum that arrived through --data too", () => {
    const result = buildRequestBody({ entry: entry(), flags: {}, data: { id: "x", mode: "wrong" } })
    expect(result).toMatchObject({ ok: false })
  })

  it("refuses a non-numeric number and a fractional integer", () => {
    expect(buildRequestBody({ entry: entry(), flags: { id: "x", count: "abc" } })).toMatchObject({
      ok: false,
    })
    expect(buildRequestBody({ entry: entry(), flags: { id: "x", count: "1.5" } })).toMatchObject({
      ok: false,
    })
    expect(buildRequestBody({ entry: entry(), flags: { id: "x", ratio: "1.5" } })).toMatchObject({
      ok: true,
    })
  })

  it("refuses a json field that is not JSON", () => {
    const result = buildRequestBody({ entry: entry(), flags: { id: "x", options: "not json" } })
    expect((result as { error: string }).error).toContain("takes JSON")
  })

  it("reads the literal null only where the schema allows it", () => {
    expect(
      buildRequestBody({ entry: entry(), flags: { id: "x", clearable: "null" } })
    ).toMatchObject({ ok: true, body: { clearable: null } })
    expect(buildRequestBody({ entry: entry(), flags: { id: "null" } })).toMatchObject({
      ok: true,
      body: { id: "null" },
    })
  })

  it("accepts true and false spellings for a boolean", () => {
    expect(buildRequestBody({ entry: entry(), flags: { id: "x", muted: "false" } })).toMatchObject({
      ok: true,
      body: { muted: false },
    })
    expect(buildRequestBody({ entry: entry(), flags: { id: "x", muted: "maybe" } })).toMatchObject({
      ok: false,
    })
  })

  it("refuses a value flag that was given no value", () => {
    const result = buildRequestBody({ entry: entry(), flags: { id: true } })
    expect((result as { error: string }).error).toContain("needs a value")
  })

  it("refuses a --data that is not an object", () => {
    expect(buildRequestBody({ entry: entry(), flags: {}, data: [1, 2] })).toMatchObject({
      ok: false,
    })
    expect(buildRequestBody({ entry: entry(), flags: {}, data: "text" })).toMatchObject({
      ok: false,
    })
  })

  it("satisfies an alias requirement group with either spelling", () => {
    const command = entry({
      flags: [
        { name: "session_id", flag: "session-id", type: "string" },
        { name: "sessionId", flag: "", type: "string" },
      ],
      requireOneOf: [["session_id", "sessionId"]],
    })
    expect(buildRequestBody({ entry: command, flags: { "session-id": "s1" } })).toMatchObject({
      ok: true,
    })
    expect(
      buildRequestBody({ entry: command, flags: {}, data: { sessionId: "s1" } })
    ).toMatchObject({ ok: true })
    const missing = buildRequestBody({ entry: command, flags: {} })
    expect((missing as { error: string }).error).toContain("session_id or sessionId")
  })

  it("makes a composed body require --data and refuse stray flags", () => {
    const command = entry({ bodyKind: "composed", flags: [] })
    const noData = buildRequestBody({ entry: command, flags: {} })
    expect((noData as { error: string }).error).toContain("needs --data")

    const withFlags = buildRequestBody({ entry: command, flags: { id: "x" }, data: {} })
    expect((withFlags as { error: string }).error).toContain("alternative request shapes")

    expect(buildRequestBody({ entry: command, flags: {}, data: { a: 1 } })).toMatchObject({
      ok: true,
      body: { a: 1 },
    })
  })
})

describe("buildRequestBody against real commands", () => {
  it("accepts a well-formed adapter_update_policy call", () => {
    const command = findCommand("adapter_update_policy")!
    expect(
      buildRequestBody({
        entry: command,
        flags: { id: "bot_1", "default-mode": "auto", "quiet-hours": '{"from":"22:00"}' },
      })
    ).toMatchObject({
      ok: true,
      body: { id: "bot_1", defaultMode: "auto", quietHours: { from: "22:00" } },
    })
  })

  it("refuses agent_send with neither session spelling", () => {
    const command = findCommand("agent_send")!
    const result = buildRequestBody({ entry: command, flags: { prompt: '"hi"' } })
    expect((result as { error: string }).error).toContain("session_id or sessionId")
  })
})

describe("requestTemplate", () => {
  it("fills each field with a placeholder of the right type", () => {
    expect(requestTemplate(entry())).toEqual({
      id: "",
      count: 0,
      ratio: 0,
      muted: false,
      options: {},
      mode: "auto",
      clearable: "",
    })
  })

  it("includes only one spelling from an alias group", () => {
    const command = entry({
      flags: [
        { name: "session_id", flag: "session-id", type: "string" },
        { name: "sessionId", flag: "", type: "string" },
      ],
      requireOneOf: [["session_id", "sessionId"]],
    })
    expect(Object.keys(requestTemplate(command))).toEqual(["session_id"])
  })

  it("returns an empty object for a composed body it cannot describe", () => {
    expect(requestTemplate(entry({ bodyKind: "composed", flags: [] }))).toEqual({})
  })

  it("produces a template that its own validator accepts", () => {
    const command = findCommand("adapter_update_policy")!
    const template = requestTemplate(command)
    expect(buildRequestBody({ entry: command, flags: {}, data: template })).toMatchObject({
      ok: true,
    })
  })
})

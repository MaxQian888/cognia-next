import { asArray, asInteger, asRecord, asString, createLlmBridge, parseJsonObject } from "./llm"

describe("createLlmBridge", () => {
  it("streams the whole answer at temperature 0 with the chosen model", async () => {
    const chat = jest.fn(async function* () {
      yield { content: '{"a":' }
      yield { content: "" }
      yield { content: "1}" }
    })
    const signal = new AbortController().signal
    const bridge = createLlmBridge({ chat }, "model-x")
    await expect(bridge.complete([{ role: "user", content: "hi" }], { signal })).resolves.toBe(
      '{"a":1}'
    )
    expect(chat).toHaveBeenCalledWith([{ role: "user", content: "hi" }], {
      model: "model-x",
      temperature: 0,
      signal,
    })
  })
})

describe("parseJsonObject", () => {
  it("takes the first balanced object out of prose and fences", () => {
    expect(
      parseJsonObject('Sure:\n```json\n{"findings":[{"a":"}"}]}\n```\nthanks {"b":2}')
    ).toEqual({
      findings: [{ a: "}" }],
    })
  })

  it("returns undefined for no object, arrays and broken JSON", () => {
    expect(parseJsonObject("no json")).toBeUndefined()
    expect(parseJsonObject("{broken")).toBeUndefined()
    expect(parseJsonObject('{"a": tru}')).toBeUndefined()
  })

  it("narrows values", () => {
    expect(asString(" x ")).toBe(" x ")
    expect(asString("  ")).toBeUndefined()
    expect(asInteger("3")).toBe(3)
    expect(asInteger(2.5)).toBeUndefined()
    expect(asArray("x")).toEqual([])
    expect(asRecord([1])).toBeUndefined()
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
  })
})

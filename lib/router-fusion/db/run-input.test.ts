import { decodeRunInput, encodeRunInput } from "./run-input"

describe("stored run input", () => {
  it("round-trips the messages and the options that judge the run", () => {
    const input = {
      messages: [
        { role: "system" as const, content: "answer in JSON" },
        { role: "user" as const, content: "rate?" },
      ],
      allowDegraded: true,
      jsonSchema: { type: "object" },
    }
    expect(decodeRunInput(encodeRunInput(input))).toEqual(input)
  })

  it("still reads the bare message array a B2 build stored", () => {
    expect(decodeRunInput(JSON.stringify([{ role: "user", content: "hi" }]))).toEqual({
      messages: [{ role: "user", content: "hi" }],
      allowDegraded: false,
      jsonSchema: null,
    })
  })

  it("keeps only well-formed messages and refuses input with none", () => {
    expect(
      decodeRunInput(
        JSON.stringify({
          messages: [
            { role: "tool", content: "x" },
            { role: "user" },
            { role: "user", content: "kept" },
          ],
          allowDegraded: "yes",
          jsonSchema: ["not", "a", "schema"],
        })
      )
    ).toEqual({
      messages: [{ role: "user", content: "kept" }],
      allowDegraded: false,
      jsonSchema: null,
    })
    for (const content of [
      null,
      undefined,
      "",
      "not json",
      "42",
      "[]",
      JSON.stringify({ messages: [] }),
    ]) {
      expect(decodeRunInput(content)).toBeNull()
    }
  })
})

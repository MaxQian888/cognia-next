import { assertSupportedInput } from "./agent-input"
import { RPC_ERROR_CODES } from "./rpc/protocol"

describe("assertSupportedInput", () => {
  it("accepts a plain string prompt", () => {
    expect(() => assertSupportedInput("fix the build")).not.toThrow()
  })

  it("accepts an object prompt with no attachments field", () => {
    expect(() => assertSupportedInput({ prompt: "fix the build" })).not.toThrow()
  })

  it("accepts an explicitly empty attachments array", () => {
    expect(() => assertSupportedInput({ prompt: "hi", attachments: [] })).not.toThrow()
  })

  it("rejects a path attachment instead of dropping it", () => {
    expect(() =>
      assertSupportedInput({ prompt: "review", attachments: [{ path: "/tmp/a.png" }] })
    ).toThrow(expect.objectContaining({ code: "invalid_params" }))
  })

  it("rejects a base64 data attachment instead of dropping it", () => {
    let thrown: unknown
    try {
      assertSupportedInput({
        prompt: "review",
        attachments: [{ data: "AAAA", mediaType: "image/png" }],
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: "invalid_params",
      rpcCode: RPC_ERROR_CODES.invalidParams,
      data: { attachmentCount: 1, shapes: ["data"] },
    })
  })

  it("names every attachment shape it found", () => {
    let thrown: unknown
    try {
      assertSupportedInput({
        prompt: "review",
        attachments: [{ path: "/tmp/a" }, { data: "AAAA" }, { name: "orphan" }],
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      data: { attachmentCount: 3, shapes: ["data", "path", "unknown"] },
    })
  })

  it("rejects a non-array attachments field", () => {
    expect(() => assertSupportedInput({ prompt: "hi", attachments: "nope" } as never)).toThrow(
      expect.objectContaining({ code: "invalid_params" })
    )
  })

  it("rejects an empty prompt", () => {
    expect(() => assertSupportedInput({ prompt: "" })).toThrow(
      expect.objectContaining({ code: "invalid_params" })
    )
  })

  it("rejects a null input", () => {
    expect(() => assertSupportedInput(null as never)).toThrow(
      expect.objectContaining({ code: "invalid_params" })
    )
  })

  it("explains what to use instead", () => {
    expect(() => assertSupportedInput({ prompt: "x", attachments: [{ path: "/tmp/a" }] })).toThrow(
      /asset references/
    )
  })
})

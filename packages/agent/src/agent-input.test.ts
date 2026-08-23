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
      /client\.assets/
    )
  })
})

describe("assertSupportedInput — asset references", () => {
  const assets = [{ assetId: "a1", digest: "sha256-x", mediaType: "image/png", byteLength: 12 }]

  it("accepts references against a host whose runtime can read them", () => {
    expect(() =>
      assertSupportedInput({ prompt: "look", assets }, ["assets-in-turn-v1"])
    ).not.toThrow()
  })

  it("refuses references against a host that can only store them", () => {
    // `assets-v1` alone means the store works, not that a turn can read one.
    expect(() => assertSupportedInput({ prompt: "look", assets }, ["assets-v1"])).toThrow(
      expect.objectContaining({ code: "capability_error" })
    )
  })

  it("ignores an empty assets array on any host", () => {
    expect(() => assertSupportedInput({ prompt: "look", assets: [] }, [])).not.toThrow()
  })

  it("requires the fields that make a reference verifiable", () => {
    for (const broken of [
      { digest: "sha256-x", mediaType: "image/png", byteLength: 1 },
      { assetId: "a1", mediaType: "image/png", byteLength: 1 },
      { assetId: "a1", digest: "sha256-x", byteLength: 1 },
      { assetId: "a1", digest: "sha256-x", mediaType: "image/png" },
    ]) {
      expect(() =>
        assertSupportedInput({ prompt: "x", assets: [broken as never] }, ["assets-in-turn-v1"])
      ).toThrow(expect.objectContaining({ code: "invalid_params" }))
    }
  })

  it("refuses bytes or a host path smuggled onto a reference", () => {
    for (const key of ["path", "data", "contents"]) {
      expect(() =>
        assertSupportedInput(
          { prompt: "x", assets: [{ ...assets[0]!, [key]: "/tmp/a" } as never] },
          ["assets-in-turn-v1"]
        )
      ).toThrow(/never bytes or host paths/)
    }
  })

  it("rejects a non-array assets field", () => {
    expect(() =>
      assertSupportedInput({ prompt: "x", assets: "nope" } as never, ["assets-in-turn-v1"])
    ).toThrow(expect.objectContaining({ code: "invalid_params" }))
  })
})

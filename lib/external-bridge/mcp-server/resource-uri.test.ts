import { parseResourceUri } from "./resource-uri"

describe("parseResourceUri", () => {
  it("parses a resource kind and preserves nested ids", () => {
    expect(parseResourceUri("cognia://wiki/project/nested")).toEqual({
      kind: "wiki",
      id: "project/nested",
    })
  })

  it.each(["https://example.com", "cognia://", "cognia://wiki", "cognia://wiki/"])(
    "rejects %s",
    (uri) => expect(parseResourceUri(uri)).toBeUndefined()
  )
})

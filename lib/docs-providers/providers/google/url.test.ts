import { googleDocUrl, parseGoogleDocUrl } from "./url"

const ID = "1AbC_dEfGhIjKlMnOpQrStUvWxYz012345"

describe("parseGoogleDocUrl", () => {
  it("parses a document URL", () => {
    expect(parseGoogleDocUrl(`https://docs.google.com/document/d/${ID}/edit`)).toEqual({
      kind: "doc",
      id: ID,
    })
  })

  it("parses a spreadsheet URL and ignores the gid fragment", () => {
    expect(parseGoogleDocUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`)).toEqual({
      kind: "sheet",
      id: ID,
    })
  })

  it("tolerates the multi-account u/<n> segment", () => {
    expect(parseGoogleDocUrl(`https://docs.google.com/document/u/0/d/${ID}/edit`)).toEqual({
      kind: "doc",
      id: ID,
    })
  })

  it("accepts a URL with no trailing action segment", () => {
    expect(parseGoogleDocUrl(`https://docs.google.com/spreadsheets/d/${ID}`)).toEqual({
      kind: "sheet",
      id: ID,
    })
  })

  it("rejects kinds this provider cannot read", () => {
    expect(parseGoogleDocUrl(`https://docs.google.com/presentation/d/${ID}/edit`)).toBeNull()
    expect(parseGoogleDocUrl(`https://docs.google.com/forms/d/${ID}/edit`)).toBeNull()
  })

  it("rejects an opaque Drive file link whose kind cannot be known synchronously", () => {
    expect(parseGoogleDocUrl(`https://drive.google.com/file/d/${ID}/view`)).toBeNull()
  })

  it("rejects other hosts, bad schemes, malformed URLs and bare ids", () => {
    expect(parseGoogleDocUrl(`https://evil.com/document/d/${ID}/edit`)).toBeNull()
    expect(parseGoogleDocUrl(`ftp://docs.google.com/document/d/${ID}`)).toBeNull()
    expect(parseGoogleDocUrl("https://")).toBeNull()
    expect(parseGoogleDocUrl(ID)).toBeNull()
    expect(parseGoogleDocUrl("   ")).toBeNull()
  })

  it("rejects a file id that fails the shape check", () => {
    expect(parseGoogleDocUrl("https://docs.google.com/document/d/short/edit")).toBeNull()
    expect(parseGoogleDocUrl("https://docs.google.com/document/d//edit")).toBeNull()
  })

  it("rejects a document path with no /d/ segment", () => {
    expect(parseGoogleDocUrl(`https://docs.google.com/document/${ID}`)).toBeNull()
  })
})

describe("googleDocUrl", () => {
  it("round-trips through parseGoogleDocUrl", () => {
    for (const kind of ["doc", "sheet"] as const) {
      expect(parseGoogleDocUrl(googleDocUrl(kind, ID))).toEqual({ kind, id: ID })
    }
  })
})

import { pathToFileUri, fileUriToPath } from "./path-uri"

describe("pathToFileUri", () => {
  it("encodes a POSIX absolute path", () => {
    expect(pathToFileUri("/home/user/project/a.ts")).toBe("file:///home/user/project/a.ts")
  })

  it("encodes a Windows drive path with forward slashes", () => {
    expect(pathToFileUri("C:\\Users\\me\\a.ts")).toBe("file:///C:/Users/me/a.ts")
  })

  it("preserves an already-forward-slashed Windows path", () => {
    expect(pathToFileUri("C:/Users/me/a.ts")).toBe("file:///C:/Users/me/a.ts")
  })

  it("percent-encodes spaces and reserved characters per segment", () => {
    expect(pathToFileUri("/home/my project/a#b.ts")).toBe("file:///home/my%20project/a%23b.ts")
  })

  it("does not encode path separators or the drive colon", () => {
    const uri = pathToFileUri("C:/a b/c.ts")
    expect(uri).toBe("file:///C:/a%20b/c.ts")
    expect(uri).not.toContain("%2F")
    expect(uri).not.toContain("%3A")
  })

  it("treats a relative-looking path as absolute-from-root", () => {
    expect(pathToFileUri("relative/a.ts")).toBe("file:///relative/a.ts")
  })
})

describe("fileUriToPath", () => {
  it("returns null for a non-file URI", () => {
    expect(fileUriToPath("skill:///abc/a.ts")).toBeNull()
    expect(fileUriToPath("https://example.com/a.ts")).toBeNull()
  })

  it("round-trips a POSIX path", () => {
    const p = "/home/user/project/a.ts"
    expect(fileUriToPath(pathToFileUri(p))).toBe(p)
  })

  it("round-trips a Windows drive path (to forward slashes)", () => {
    expect(fileUriToPath(pathToFileUri("C:\\Users\\me\\a.ts"))).toBe("C:/Users/me/a.ts")
  })

  it("round-trips paths with spaces and reserved characters", () => {
    const p = "/home/my project/a#b?c.ts"
    expect(fileUriToPath(pathToFileUri(p))).toBe(p)
  })

  it("decodes a Windows drive URI back to a drive path", () => {
    expect(fileUriToPath("file:///C:/Users/me/a.ts")).toBe("C:/Users/me/a.ts")
  })

  it("tolerates a malformed percent-escape without throwing", () => {
    expect(fileUriToPath("file:///home/user/a%ZZb.ts")).toBe("/home/user/a%ZZb.ts")
  })
})

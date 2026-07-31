/**
 * @jest-environment node
 */
import { activeAtToken, completeAtPath, splitToken, type DirEntry } from "./file-completer"

const listing: Record<string, DirEntry[]> = {
  ".": [
    { name: "src", isDir: true },
    { name: "spec", isDir: true },
    { name: "readme.md", isDir: false },
    { name: ".git", isDir: true },
    { name: ".env", isDir: false },
  ],
  src: [
    { name: "app.ts", isDir: false },
    { name: "api", isDir: true },
  ],
}
const listDir = (dir: string): DirEntry[] => listing[dir] ?? []

describe("splitToken", () => {
  it("splits a bare prefix", () => {
    expect(splitToken("@re")).toEqual({ dir: ".", prefix: "re" })
  })
  it("splits a nested path", () => {
    expect(splitToken("@src/ap")).toEqual({ dir: "src", prefix: "ap" })
  })
  it("handles a root path", () => {
    expect(splitToken("@/etc")).toEqual({ dir: "/", prefix: "etc" })
  })
})

describe("activeAtToken", () => {
  it("detects a trailing @token", () => {
    expect(activeAtToken("look at @src/ap")).toEqual({ token: "@src/ap", start: 8 })
  })
  it("detects an @token at the start", () => {
    expect(activeAtToken("@re")).toEqual({ token: "@re", start: 0 })
  })
  it("returns null when not in an @ reference", () => {
    expect(activeAtToken("plain text")).toBeNull()
    expect(activeAtToken("a@b c")).toBeNull()
  })
})

describe("completeAtPath", () => {
  it("completes top-level entries, directories first", () => {
    expect(completeAtPath("@s", listDir)).toEqual(["@spec/", "@src/"])
  })
  it("completes nested entries with the directory prefix", () => {
    expect(completeAtPath("@src/a", listDir)).toEqual(["@src/api/", "@src/app.ts"])
  })
  it("returns [] when the directory cannot be listed", () => {
    const throwing = () => {
      throw new Error("nope")
    }
    expect(completeAtPath("@x/y", throwing)).toEqual([])
  })
  it("matches case-insensitively so @S still finds lowercase entries", () => {
    expect(completeAtPath("@S", listDir)).toEqual(["@spec/", "@src/"])
    expect(completeAtPath("@README", listDir)).toEqual(["@readme.md"])
  })
  it("hides dotfiles unless the prefix opts into them", () => {
    // An empty/non-dot prefix omits hidden entries...
    expect(completeAtPath("@", listDir)).toEqual(["@spec/", "@src/", "@readme.md"])
    // ...a leading dot reveals them.
    expect(completeAtPath("@.", listDir)).toEqual(["@.git/", "@.env"])
  })
})

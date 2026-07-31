/**
 * @jest-environment node
 */
import { activeBashPathToken, completeBashPath } from "./bash-completer"
import type { DirEntry } from "./file-completer"

const listing: Record<string, DirEntry[]> = {
  ".": [
    { name: "src", isDir: true },
    { name: "spec", isDir: true },
    { name: "readme.md", isDir: false },
    { name: ".git", isDir: true },
  ],
  src: [
    { name: "app.ts", isDir: false },
    { name: "api", isDir: true },
  ],
}
const listDir = (dir: string): DirEntry[] => listing[dir] ?? []

describe("activeBashPathToken", () => {
  it("detects a trailing argument token preceded by whitespace", () => {
    expect(activeBashPathToken("!cat sr")).toEqual({ token: "sr", start: 5 })
  })
  it("detects a nested-path argument and keeps drilling on a dir", () => {
    expect(activeBashPathToken("!cat src/a")).toEqual({ token: "src/a", start: 5 })
    expect(activeBashPathToken("!cat src/")).toEqual({ token: "src/", start: 5 })
  })
  it("ignores the command name (the first token after !)", () => {
    expect(activeBashPathToken("!ca")).toBeNull()
    expect(activeBashPathToken("!")).toBeNull()
  })
  it("ignores flags and lines that are not bash mode", () => {
    expect(activeBashPathToken("!ls -l")).toBeNull()
    expect(activeBashPathToken("cat sr")).toBeNull()
  })
  it("does not fire on an empty token right after a space", () => {
    expect(activeBashPathToken("!cat ")).toBeNull()
  })
})

describe("completeBashPath", () => {
  it("returns bare path candidates (no @ sigil), directories first", () => {
    expect(completeBashPath("s", listDir)).toEqual([
      { kind: "file", id: "spec/", label: "spec/", insert: "spec/" },
      { kind: "file", id: "src/", label: "src/", insert: "src/" },
    ])
  })
  it("completes nested entries with the directory prefix", () => {
    expect(completeBashPath("src/a", listDir).map((c) => c.insert)).toEqual([
      "src/api/",
      "src/app.ts",
    ])
  })
  it("hides dotfiles unless the prefix opts into them", () => {
    expect(completeBashPath("", listDir).map((c) => c.insert)).toEqual([
      "spec/",
      "src/",
      "readme.md",
    ])
    expect(completeBashPath(".", listDir).map((c) => c.insert)).toEqual([".git/"])
  })
})

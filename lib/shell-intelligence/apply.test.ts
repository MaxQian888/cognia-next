import { applyShellCompletion } from "./apply"
import type { ShellCompletion } from "./types"

const completion = (over: Partial<ShellCompletion>): ShellCompletion => ({
  label: "x",
  insertText: "x",
  from: 0,
  to: 0,
  kind: "path",
  ...over,
})

describe("applyShellCompletion", () => {
  it("replaces the candidate's span and lands the caret after it", () => {
    expect(
      applyShellCompletion(
        "kub",
        completion({ insertText: "kubectl", from: 0, to: 3, kind: "command" })
      )
    ).toEqual({ line: "kubectl ", cursor: 8 })
  })

  it("adds a trailing space after a file so the next argument can be typed", () => {
    expect(
      applyShellCompletion("cat RE", completion({ insertText: "README.md", from: 4, to: 6 }))
    ).toEqual({ line: "cat README.md ", cursor: 14 })
  })

  it("does NOT add a space after a directory, so the next segment completes", () => {
    expect(
      applyShellCompletion(
        "cat ./sr",
        completion({ insertText: "./src/", from: 4, to: 8, kind: "directory", continues: true })
      )
    ).toEqual({ line: "cat ./src/", cursor: 10 })
  })

  it("never doubles a space that is already there", () => {
    expect(
      applyShellCompletion("cat RE next", completion({ insertText: "README.md", from: 4, to: 6 }))
    ).toEqual({ line: "cat README.md next", cursor: 13 })
  })

  it("completes mid-line without disturbing the tail", () => {
    expect(
      applyShellCompletion(
        "cat foo | gre | wc",
        completion({ insertText: "grep", from: 10, to: 13, kind: "command" })
      )
    ).toEqual({ line: "cat foo | grep | wc", cursor: 14 })
  })

  it("inserts into an empty span", () => {
    expect(
      applyShellCompletion("cat ", completion({ insertText: "a.txt", from: 4, to: 4 }))
    ).toEqual({ line: "cat a.txt ", cursor: 10 })
  })
})

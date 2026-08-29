import { cursorSessionSource } from "./cursor"

describe("cursorSessionSource", () => {
  it("supports local exports and subagent roots without cloud access", () => {
    expect(cursorSessionSource.acceptedExtensions).toEqual(
      expect.arrayContaining([".json", ".jsonl", ".md"])
    )
    expect(cursorSessionSource.scanRoots("/home/u")).toEqual(
      expect.arrayContaining(["/home/u/.cursor/chats", "/home/u/.cursor/subagents"])
    )
    expect(cursorSessionSource.scanRoots("")).toEqual([])
  })
})

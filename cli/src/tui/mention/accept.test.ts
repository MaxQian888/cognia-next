/**
 * @jest-environment node
 */
import { acceptMention } from "./accept"
import type { InputBuffer } from "../state/types"
import type { DetectedMention, MentionCandidate } from "./types"

const buf = (line: string, col = line.length): InputBuffer => ({
  lines: [line],
  cursorRow: 0,
  cursorCol: col,
})

const fileDir: MentionCandidate = { kind: "file", id: "@src/", label: "@src/", insert: "@src/" }
const fileLeaf: MentionCandidate = {
  kind: "file",
  id: "@readme.md",
  label: "@readme.md",
  insert: "@readme.md",
}
const skill: MentionCandidate = {
  kind: "skill",
  id: "skill_cite",
  label: "Cite",
  insert: "@skill:skill_cite",
}
const agent: MentionCandidate = {
  kind: "agent",
  id: "researcher",
  label: "researcher",
  insert: "@agent:researcher",
}

describe("acceptMention", () => {
  it("inserts a directory without a trailing space and leaves the cursor after the slash", () => {
    const detected: DetectedMention = { query: "s", start: 0, mode: "file" }
    const out = acceptMention(buf("@s"), detected, fileDir)
    expect(out.lines[0]).toBe("@src/")
    expect(out.cursorCol).toBe("@src/".length)
  })

  it("inserts a file leaf with a trailing space", () => {
    const detected: DetectedMention = { query: "read", start: 0, mode: "file" }
    const out = acceptMention(buf("@read"), detected, fileLeaf)
    expect(out.lines[0]).toBe("@readme.md ")
    expect(out.cursorCol).toBe("@readme.md ".length)
  })

  it("inserts a skill token with a trailing space", () => {
    const detected: DetectedMention = { query: "cit", start: 0, mode: "skill" }
    const out = acceptMention(buf("@skill:cit"), detected, skill)
    expect(out.lines[0]).toBe("@skill:skill_cite ")
    expect(out.cursorCol).toBe("@skill:skill_cite ".length)
  })

  it("inserts an agent token with a trailing space", () => {
    const detected: DetectedMention = { query: "res", start: 4, mode: "agent" }
    const out = acceptMention(buf("run @agent:res"), detected, agent)
    expect(out.lines[0]).toBe("run @agent:researcher ")
  })

  it("preserves text before the @ and after the cursor", () => {
    const line = "hi @cit done"
    const detected: DetectedMention = { query: "cit", start: 3, mode: "skill" }
    // cursor sits right after "cit" (col 7), text " done" follows
    const out = acceptMention(buf(line, 7), detected, skill)
    expect(out.lines[0]).toBe("hi @skill:skill_cite  done")
  })

  it("only touches the cursor row in a multiline buffer", () => {
    const b: InputBuffer = { lines: ["first", "@s"], cursorRow: 1, cursorCol: 2 }
    const detected: DetectedMention = { query: "s", start: 0, mode: "file" }
    const out = acceptMention(b, detected, fileDir)
    expect(out.lines).toEqual(["first", "@src/"])
    expect(out.cursorRow).toBe(1)
  })
})

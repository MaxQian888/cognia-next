/**
 * @jest-environment node
 */
import { detectMention } from "./detector"

describe("detectMention", () => {
  it("returns null when the cursor is not in an @ reference", () => {
    expect(detectMention("plain text")).toBeNull()
    expect(detectMention("a@b")).toBeNull() // @ not preceded by start/space
    expect(detectMention("")).toBeNull()
  })

  it("detects a bare @ as mixed mode at the line start", () => {
    expect(detectMention("@")).toEqual({ query: "", start: 0, mode: "mixed" })
  })

  it("detects a bare @word as mixed mode", () => {
    expect(detectMention("hello @rev")).toEqual({ query: "rev", start: 6, mode: "mixed" })
  })

  it("classifies @skill: as skill mode and strips the prefix", () => {
    expect(detectMention("@skill:cit")).toEqual({ query: "cit", start: 0, mode: "skill" })
  })

  it("classifies @agent: as agent mode and strips the prefix", () => {
    expect(detectMention("run @agent:code")).toEqual({ query: "code", start: 4, mode: "agent" })
  })

  it("classifies @file: as file mode and strips the prefix", () => {
    expect(detectMention("@file:src/app")).toEqual({ query: "src/app", start: 0, mode: "file" })
  })

  it("treats a slash-shaped bare token as a file (legacy @path)", () => {
    expect(detectMention("@src/ap")).toEqual({ query: "src/ap", start: 0, mode: "file" })
  })

  it("treats a backslash-shaped bare token as a file", () => {
    expect(detectMention("@src\\ap")).toEqual({ query: "src\\ap", start: 0, mode: "file" })
  })

  it("is case-insensitive on the prefix", () => {
    expect(detectMention("@SKILL:x")).toEqual({ query: "x", start: 0, mode: "skill" })
  })

  it("computes start relative to the @ position with preceding text", () => {
    const text = "look at @agent:researcher"
    const d = detectMention(text)
    expect(d?.start).toBe(text.indexOf("@"))
    expect(d?.mode).toBe("agent")
    expect(d?.query).toBe("researcher")
  })

  it("only considers the trailing token", () => {
    expect(detectMention("@skill:a and @agent:b")).toEqual({
      query: "b",
      start: 13,
      mode: "agent",
    })
  })
})

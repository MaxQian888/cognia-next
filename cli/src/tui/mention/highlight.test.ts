/**
 * @jest-environment node
 */
import { highlightMentions } from "./highlight"

describe("highlightMentions", () => {
  it("returns a single plain segment for a line with no tokens", () => {
    expect(highlightMentions("hello world")).toEqual([{ text: "hello world" }])
  })

  it("returns a single plain segment for an empty line", () => {
    expect(highlightMentions("")).toEqual([{ text: "" }])
  })

  it("splits a skill token out of surrounding text", () => {
    expect(highlightMentions("use @skill:cite please")).toEqual([
      { text: "use " },
      { text: "@skill:cite", kind: "skill" },
      { text: " please" },
    ])
  })

  it("tags agent and file tokens with their kind", () => {
    expect(highlightMentions("@agent:rev @file:src/a.ts")).toEqual([
      { text: "@agent:rev", kind: "agent" },
      { text: " " },
      { text: "@file:src/a.ts", kind: "file" },
    ])
  })

  it("does not treat a bare @path (no prefix) as a token", () => {
    expect(highlightMentions("@src/app.ts")).toEqual([{ text: "@src/app.ts" }])
  })

  it("handles a token at the very end with no trailing text", () => {
    expect(highlightMentions("run @skill:concise")).toEqual([
      { text: "run " },
      { text: "@skill:concise", kind: "skill" },
    ])
  })
})
